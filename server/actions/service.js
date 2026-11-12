// Background action extraction. Queues notes after they are saved, waits until the MLX service is idle (user-facing
// work always goes first, the same rule translation follows), runs the grounded extraction pipeline and hands the
// items to the action store. It never blocks saving, filing or capture: every failure is logged and swallowed.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import { PROMPT_VERSION, extractActions } from './extraction/pipeline.js'
import { mlxEmbed, mlxGenerate } from './extraction/mlx-adapters.js'
import { MATCHING_VERSION, applyNoteMatching, askWith, createVectorCache, matchCompletions } from './matching/apply.js'

const MAX_CONSECUTIVE_ERRORS = 3
const SKIPPED = ['/todo-list.md', '/references/']

export const hashContent = (content) => createHash('sha256').update(content).digest('hex')

export function createActionService(runtime, options = {}) {
  const settings = {
    enabled: process.env.FOLIO_ACTION_EXTRACTION !== '0', debounceMs: 4_000, backfillDelayMs: 10_000, busyPollMs: 500, statusTtlMs: 5_000,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', ...runtime.actionOptions, ...options,
  }
  const queue = []
  const priority = new Set()
  const debounceTimers = new Map()
  const versions = new Map()
  const sleepers = new Set()
  const counters = { processed: 0, skipped: 0, failed: 0, itemsAdded: 0, repeatsMerged: 0, autoCompleted: 0, completionsSuggested: 0 }
  let running = null
  let backfill = null
  let backfillTimer = null
  let closed = false
  let warnedMissingStore = false
  let lastError = null
  let modelCache = { at: 0, value: null }
  let vectorCache = null

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sleepers.delete(done); resolve() }, ms)
      const done = () => { clearTimeout(timer); sleepers.delete(done); resolve() }
      sleepers.add(done)
    })
  }

  // The selected generation model (and whether embeddings are installed) when installed; never downloads.
  async function installed({ fresh = false } = {}) {
    if (!fresh && Date.now() - modelCache.at < settings.statusTtlMs) return modelCache.value
    let value = null
    try {
      const status = await runtime.mlxService.status()
      if (status.available !== false) {
        const models = status.models || []
        const model = models.find((item) => item.purpose === 'generation' && item.selected && item.installed)
        value = model ? { id: model.id, embeddings: models.some((item) => item.purpose === 'embeddings' && item.installed) } : null
      }
    } catch { value = null }
    modelCache = { at: Date.now(), value }
    return value
  }

  function usable() {
    if (closed || !settings.enabled) return false
    if (runtime.actionStore) return true
    if (!warnedMissingStore) { warnedMissingStore = true; console.warn('Action extraction is idle: no action store is available.') }
    return false
  }

  async function waitForTurn() {
    while (!closed) {
      if (!(await installed())) return false
      if (!runtime.mlxService.isBusy?.()) return true
      await sleep(settings.busyPollMs)
    }
    return false
  }

  function skippedId(id) {
    return SKIPPED.some((entry) => (entry.endsWith('/') ? id.startsWith(entry) : id === entry))
  }

  // The note body as held in the knowledge index (`record.content`): the store re-anchors against the same text.
  // `records` may be a prefetched id -> record map (backfill) so a whole bundle is read from the index once.
  async function readNote(id, records = null) {
    const filePath = runtime.resolveBundleMarkdownPath(id)
    if (!filePath) return null
    try {
      const record = records ? records.get(id) : (await runtime.readRecords()).find((entry) => entry.id === id)
      if (typeof record?.content !== 'string') return null
      await runtime.assertNoBundleSymlinks(filePath)
      const stat = await fs.stat(filePath)
      return { content: record.content, hash: hashContent(record.content), modifiedAt: stat.mtime }
    } catch { return null }
  }

  // Matching (#21) needs the store methods; the older in-memory stores some tests inject do not have them.
  const matchable = () => typeof runtime.actionStore.mergeRepeat === 'function' && typeof runtime.actionStore.openForMatching === 'function'
  const extractionCurrent = (id, hash) => {
    const state = runtime.actionStore.noteState(id)
    return Boolean(state && state.contentHash === hash && state.promptVersion === PROMPT_VERSION)
  }
  const matchingCurrent = (id) => !matchable() || runtime.actionStore.noteState(id)?.matchingVersion === MATCHING_VERSION
  const isCurrent = (id, hash) => extractionCurrent(id, hash) && matchingCurrent(id)
  const referenceTime = (note) => (note.modifiedAt.getTime() < Date.now() ? note.modifiedAt : new Date())

  // Resolves to 'done', 'skip', 'stop' or 'error'.
  async function processNote(id) {
    if (skippedId(id)) return 'skip'
    const version = versions.get(id) || 0
    const note = await readNote(id)
    if (!note || !note.content.trim() || isCurrent(id, note.hash)) { counters.skipped += 1; return 'skip' }
    // Only matching is out of date: no model call is needed to recheck completions against the open actions.
    if (extractionCurrent(id, note.hash)) {
      try {
        const found = await matchCompletions({
          store: runtime.actionStore, noteId: id, content: note.content, now: referenceTime(note), timeZone: settings.timeZone, open: runtime.actionStore.openForMatching(),
        })
        counters.autoCompleted += found.completed.length
        counters.completionsSuggested += found.suggested.length
      } catch (error) { console.error(`Action matching of ${id} failed. ${error.message}`) }
      await runtime.actionStore.setNoteState(id, { contentHash: note.hash, promptVersion: PROMPT_VERSION, matchingVersion: MATCHING_VERSION, processedAt: new Date().toISOString() })
      return 'done'
    }
    if (!(await waitForTurn())) return 'stop'
    if ((versions.get(id) || 0) !== version) return 'skip'
    const model = await installed()
    if (!model) return 'stop'
    const generate = mlxGenerate(runtime.mlxService)
    const gated = async (messages, callOptions) => {
      if (!(await waitForTurn())) throw Object.assign(new Error('Extraction was cancelled.'), { reason: 'cancelled' })
      return generate(messages, callOptions)
    }
    const at = referenceTime(note)
    if (model.embeddings && !vectorCache) vectorCache = createVectorCache(mlxEmbed(runtime.mlxService))
    if (!model.embeddings) vectorCache = null
    const result = await extractActions({
      content: note.content, noteId: id, now: at, timeZone: settings.timeZone, generate: gated,
      embed: model.embeddings ? mlxEmbed(runtime.mlxService) : null, options: { modelId: model.id },
    })
    if (closed || (versions.get(id) || 0) !== version) return 'skip'
    let outcome
    if (matchable()) {
      const matched = await applyNoteMatching({
        store: runtime.actionStore, noteId: id, content: note.content, items: result.items, noteVersion: note.hash, at, timeZone: settings.timeZone,
        vectors: vectorCache, ask: askWith(gated),
      })
      outcome = matched.added
      counters.repeatsMerged += matched.merged.length
      counters.autoCompleted += matched.completions.completed.length
      counters.completionsSuggested += matched.completions.suggested.length
    } else outcome = await runtime.actionStore.addFromExtraction(id, result.items, { noteVersion: note.hash, at })
    counters.itemsAdded += outcome?.added?.length ?? 0
    // A note whose model calls failed is not marked as processed, so a later save or backfill retries it.
    if (result.stats.degraded.length) return 'error'
    await runtime.actionStore.setNoteState(id, {
      contentHash: note.hash, promptVersion: PROMPT_VERSION, processedAt: new Date().toISOString(), ...(matchable() ? { matchingVersion: MATCHING_VERSION } : {}),
    })
    counters.processed += 1
    return 'done'
  }

  async function runQueue() {
    let errors = 0
    while (queue.length && !closed) {
      const id = queue.shift()
      let outcome = 'done'
      try { outcome = await processNote(id) } catch (error) {
        outcome = 'error'
        lastError = error.message
        console.error(`Action extraction of ${id} failed. ${error.message}`)
      }
      priority.delete(id)
      if (outcome === 'error') { counters.failed += 1; errors += 1 } else errors = 0
      if (outcome === 'stop' || errors >= MAX_CONSECUTIVE_ERRORS) queue.length = 0
    }
  }

  function kick() {
    if (running || closed) return
    running = runQueue().catch((error) => console.error(`Action queue failed. ${error.message}`)).finally(() => { running = null })
  }

  function addToQueue(id, { front = false } = {}) {
    const index = queue.indexOf(id)
    if (index >= 0) queue.splice(index, 1)
    if (front) queue.unshift(id)
    else queue.push(id)
    kick()
  }

  const validId = (id) => typeof id === 'string' && !skippedId(id) && Boolean(runtime.resolveBundleMarkdownPath(id))

  function enqueue(id) {
    if (!usable() || !validId(id)) return false
    versions.set(id, (versions.get(id) || 0) + 1)
    clearTimeout(debounceTimers.get(id))
    if (!settings.debounceMs) { addToQueue(id); return true }
    const timer = setTimeout(() => { debounceTimers.delete(id); addToQueue(id) }, settings.debounceMs)
    timer.unref?.()
    debounceTimers.set(id, timer)
    return true
  }

  function prioritize(id) {
    if (!usable() || !validId(id)) return false
    clearTimeout(debounceTimers.get(id))
    debounceTimers.delete(id)
    priority.add(id)
    addToQueue(id, { front: true })
    return true
  }

  async function runBackfill() {
    if (!usable() || !(await installed())) return
    const records = new Map((await runtime.readRecords()).map((record) => [record.id, record]))
    for (const filePath of await runtime.listBundleMarkdownFiles()) {
      if (closed) return
      const id = runtime.bundleFileId(filePath)
      if (!skippedId(id) && !queue.includes(id)) {
        const note = await readNote(id, records)
        if (note?.content.trim() && !isCurrent(id, note.hash)) queue.push(id)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    kick()
  }

  function startBackfill() {
    if (!usable()) return
    clearTimeout(backfillTimer)
    backfillTimer = setTimeout(() => {
      backfill = runBackfill().catch((error) => console.error(`Action backfill failed. ${error.message}`)).finally(() => { backfill = null })
    }, settings.backfillDelayMs)
    backfillTimer.unref?.()
  }

  async function idle() {
    while (running || backfill || queue.length || debounceTimers.size) await (running || backfill || sleep(10))
  }

  async function close() {
    closed = true
    queue.length = 0
    priority.clear()
    clearTimeout(backfillTimer)
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    for (const wake of [...sleepers]) wake()
    await Promise.race([Promise.allSettled([running, backfill].filter(Boolean)), new Promise((resolve) => setTimeout(resolve, 3_000).unref?.())])
  }

  function status() {
    return {
      enabled: settings.enabled, storeAvailable: Boolean(runtime.actionStore), promptVersion: PROMPT_VERSION,
      queued: queue.length + debounceTimers.size, running: Boolean(running), lastError, ...counters,
    }
  }

  return { enqueue, prioritize, startBackfill, idle, close, status }
}
