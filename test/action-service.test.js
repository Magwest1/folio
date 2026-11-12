import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime } from '../server/app.js'
import { PROMPT_VERSION } from '../server/actions/extraction/pipeline.js'
import { createActionService, hashContent } from '../server/actions/service.js'

const sentenceOf = (messages) => messages.at(-1).content.match(/<sentence>([\s\S]*?)<\/sentence>/)[1]

function fakeMlx({ busy = () => false, installed = true } = {}) {
  const calls = []
  return {
    calls,
    status: async () => ({ available: true, models: [{ id: 'gemma4', purpose: 'generation', selected: true, installed }] }),
    isBusy: busy,
    generate: async (messages, options) => {
      calls.push({ sentence: sentenceOf(messages), options })
      const sentence = sentenceOf(messages)
      const reply = /Sofia/.test(sentence) ? { is_action: true, actor: 'me', summary: 'Call Sofia', person: 'Sofia', time_phrase: 'Monday' }
        : /invoice/.test(sentence) ? { is_action: true, actor: 'me', summary: 'Send invoice to Harper', person: 'Harper', time_phrase: 'Friday' }
          : { is_action: false, actor: 'unknown', summary: '', person: null, time_phrase: null }
      return { text: JSON.stringify(reply), modelId: 'gemma4' }
    },
    embed: async () => { throw new Error('embeddings are not installed') },
  }
}

// In-memory stand-in for the action store built in #15.
function fakeStore() {
  const states = new Map()
  const store = {
    additions: [],
    states,
    noteState: (id) => states.get(id) ?? null,
    setNoteState: async (id, state) => { states.set(id, state) },
    addFromExtraction: async (noteId, items, options) => { store.additions.push({ noteId, items, options }); return { added: items, updated: [], suppressed: [] } },
  }
  return store
}

const NOTE = '- [ ] Send invoice to Harper by Friday\n'

async function setup(context, { mlx = fakeMlx(), store = fakeStore(), notes = { '/a.md': NOTE }, serviceOptions = {} } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-actions-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: path.join(dataRoot, 'models') }, mlx)
  runtime.actionStore = store ?? null // createRuntime now builds a real store; each test chooses its own
  for (const [id, content] of Object.entries(notes)) await writeNote(runtime, id, content)
  await runtime.reindexBundle()
  const service = createActionService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5, timeZone: 'Europe/Oslo', ...serviceOptions })
  context.after(() => service.close())
  return { runtime, mlx, store, service }
}

async function writeNote(runtime, id, content) {
  const filePath = path.join(runtime.bundleRoot, id)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

test('extracts a queued note and stores items with the agreed shapes', async (context) => {
  const { service, store, mlx, runtime } = await setup(context)
  const indexed = (await runtime.readRecords()).find((record) => record.id === '/a.md').content
  assert.equal(service.enqueue('/a.md'), true)
  await service.idle()
  assert.equal(mlx.calls.length, 1)
  assert.deepEqual(mlx.calls[0].options, { maxTokens: 96, temperature: 0 })
  assert.equal(store.additions.length, 1)
  const [{ noteId, items, options }] = store.additions
  assert.equal(noteId, '/a.md')
  assert.equal(options.noteVersion, hashContent(indexed))
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'open')
  assert.equal(items[0].origin, 'auto')
  assert.equal(items[0].anchor.quote, 'Send invoice to Harper by Friday')
  assert.equal(indexed.slice(items[0].anchor.from, items[0].anchor.to), items[0].anchor.quote, 'offsets index the record content')
  assert.equal(items[0].promptVersion, PROMPT_VERSION)
  const state = store.noteState('/a.md')
  assert.equal(state.contentHash, options.noteVersion)
  assert.equal(state.promptVersion, PROMPT_VERSION)
  assert.ok(Date.parse(state.processedAt))
  assert.equal(service.status().processed, 1)
})

test('skips a note whose content hash and prompt version are unchanged, and reprocesses after an edit', async (context) => {
  const { service, store, mlx, runtime } = await setup(context)
  service.enqueue('/a.md')
  await service.idle()
  service.enqueue('/a.md')
  await service.idle()
  assert.equal(mlx.calls.length, 1)
  assert.equal(store.additions.length, 1)

  store.states.set('/a.md', { ...store.states.get('/a.md'), promptVersion: 'extract-old' })
  service.enqueue('/a.md')
  await service.idle()
  assert.equal(mlx.calls.length, 2, 'a new prompt version reprocesses')

  await writeNote(runtime, '/a.md', `${NOTE}- [ ] Call Sofia on Monday\n`)
  await runtime.reindexBundle()
  service.enqueue('/a.md')
  await service.idle()
  assert.equal(store.additions.length, 3)
})

test('skips the todo list, reference notes and empty notes', async (context) => {
  const { service, store, mlx } = await setup(context, { notes: { '/todo-list.md': '- [ ] Buy milk\n', '/references/inbox/raw.md': '- [ ] Stir the pot\n', '/empty.md': '\n\n' } })
  for (const id of ['/todo-list.md', '/references/inbox/raw.md', '/empty.md']) service.enqueue(id)
  await service.idle()
  assert.equal(mlx.calls.length, 0)
  assert.equal(store.additions.length, 0)
})

test('processes daily notes', async (context) => {
  const { service, store } = await setup(context, { notes: { '/daily/2026-11-12.md': NOTE } })
  service.enqueue('/daily/2026-11-12.md')
  await service.idle()
  assert.equal(store.additions.length, 1)
})

test('waits while MLX is busy with user-facing work', async (context) => {
  let busy = true
  const mlx = fakeMlx({ busy: () => busy })
  const { service, store } = await setup(context, { mlx })
  service.enqueue('/a.md')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mlx.calls.length, 0)
  assert.equal(store.additions.length, 0)
  busy = false
  await service.idle()
  assert.equal(mlx.calls.length, 1)
  assert.equal(store.additions.length, 1)
})

test('does nothing without an installed generation model', async (context) => {
  const { service, store, mlx } = await setup(context, { mlx: fakeMlx({ installed: false }) })
  service.enqueue('/a.md')
  await service.idle()
  assert.equal(mlx.calls.length, 0)
  assert.equal(store.additions.length, 0)
})

test('is a no-op that logs once when there is no action store', async (context) => {
  const warnings = []
  context.mock.method(console, 'warn', (message) => warnings.push(message))
  const { service, mlx } = await setup(context, { store: null })
  assert.equal(service.enqueue('/a.md'), false)
  assert.equal(service.enqueue('/a.md'), false)
  assert.equal(service.prioritize('/a.md'), false)
  service.startBackfill()
  await service.idle()
  assert.equal(mlx.calls.length, 0)
  assert.equal(warnings.length, 1)
  assert.equal(service.status().storeAvailable, false)
})

test('can be disabled and ignores unknown notes', async (context) => {
  const { service, mlx } = await setup(context, { serviceOptions: { enabled: false } })
  assert.equal(service.enqueue('/a.md'), false)
  await service.idle()
  assert.equal(mlx.calls.length, 0)
  const enabled = await setup(context)
  assert.equal(enabled.service.enqueue(42), false)
  assert.equal(enabled.service.enqueue('/missing.md'), true)
  await enabled.service.idle()
  assert.equal(enabled.store.additions.length, 0)
})

test('model failures do not mark the note as processed and never reach auto-add', async (context) => {
  const mlx = fakeMlx()
  mlx.generate = async () => { throw new Error('worker crashed') }
  const { service, store } = await setup(context, { mlx })
  service.enqueue('/a.md')
  await service.idle()
  assert.equal(store.additions.length, 1)
  assert.ok(store.additions[0].items.every((item) => item.origin === 'suggested'))
  assert.equal(store.noteState('/a.md'), null, 'retried by a later save or backfill')
  assert.equal(service.status().failed, 1)
})

test('backfill queues notes that are new or stale and leaves current ones alone', async (context) => {
  const store = fakeStore()
  const { service, mlx, runtime } = await setup(context, { store, notes: { '/a.md': NOTE, '/b.md': '- [ ] Call Sofia on Monday\n' } })
  const bodyOf = async (id) => (await runtime.readRecords()).find((record) => record.id === id).content
  store.states.set('/b.md', { contentHash: hashContent(await bodyOf('/b.md')), promptVersion: PROMPT_VERSION, processedAt: new Date().toISOString() })
  service.startBackfill()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await service.idle()
  assert.deepEqual(store.additions.map((entry) => entry.noteId), ['/a.md'])
  assert.equal(mlx.calls.length, 1)
})
