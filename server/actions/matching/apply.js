// Applies matching to one processed note: extracted items that repeat an open commitment from another note are merged
// into it, and completion sentences finish (or suggest finishing) open actions. Used by the action service and by the
// evaluation harness, so both run exactly the same decisions. Matching never creates or re-opens actions: closed
// actions (done, let go, rejected, faded) are not candidates.
import { detectActionCandidates } from '../detector.js'
import { fingerprintFor, quoteKey } from '../fingerprint.js'
import { askCompletion, MAX_QUESTIONS_PER_NOTE } from './ask.js'
import { findCompletion } from './completion.js'
import { findRepeat } from './repeat.js'

const CLOSED_FOR_REPEAT = ['let-go', 'rejected']

/** Bump when the matching rules change enough that already processed notes should be matched again. */
export { MATCHING_VERSION } from '../store-matching.js'

const VECTOR_CACHE_LIMIT = 4000

/** Embeds texts once and remembers the vectors. `texts` resolves to a Map of text -> vector, or null on failure. */
export function createVectorCache(embed) {
  const cache = new Map()
  return async function vectors(texts) {
    if (!embed) return null
    try {
      const missing = [...new Set(texts)].filter((text) => text && !cache.has(text))
      if (missing.length) {
        const result = await embed(missing)
        if (!Array.isArray(result) || result.length !== missing.length) return null
        missing.forEach((text, index) => cache.set(text, result[index]))
        while (cache.size > VECTOR_CACHE_LIMIT) cache.delete(cache.keys().next().value)
      }
      return cache
    } catch { return null }
  }
}

const noteOf = (action) => action.anchor?.noteId ?? null

/**
 * Splits `items` into those merged into an existing open action and those that stay new. Items that the store would
 * suppress (let go, rejected, done in the same passage) or that already have an action in this note are left alone for
 * `addFromExtraction` to handle.
 */
export async function mergeRepeats({ store, noteId, items, noteVersion = null, vectors = null, open }) {
  const merged = []
  const rest = []
  const dropped = []
  // Something the user let go of or rejected stays closed when a later note words it differently.
  const closed = store.list({ status: ['let-go', 'rejected'] })
  const here = store.list({ includeClosed: true }).filter((action) => noteOf(action) === noteId)
  const candidates = open.filter((action) => noteOf(action) !== noteId)
  const embeddings = items.length && (candidates.length || closed.length)
    ? await vectors?.([...items.map((item) => item.text), ...candidates.map((action) => action.text), ...closed.map((action) => action.text)]) : null
  for (const item of items) {
    const quote = item.anchor?.quote ?? ''
    const fingerprint = fingerprintFor({ quote, text: item.text })
    const present = here.some((action) => (fingerprint.quoteKey && action.fingerprint?.quoteKey === fingerprint.quoteKey) || (fingerprint.textKey && action.fingerprint?.textKey === fingerprint.textKey))
    const suppressed = store.isSuppressed({ noteId, quote, text: item.text, kind: item.kind })
    const hit = !present && !suppressed && item.anchor ? findRepeat(item, candidates, { embeddings }) : null
    const result = hit ? store.mergeRepeat(hit.action.id, item, { noteId, noteVersion }) : null
    if (result) { merged.push({ item, action: result, score: hit.score, reasons: hit.reasons }); continue }
    if (!present && !suppressed && !hit && findRepeat(item, closed, { embeddings, statuses: CLOSED_FOR_REPEAT })) dropped.push(item)
    else rest.push(item)
  }
  return { merged, rest, dropped }
}

/**
 * Matches the completion sentences of `content` against open actions. `ask` is an optional `(sentence, task) =>
 * Promise<boolean>` for ambiguous matches. Returns `{ completed, suggested, asked }` lists of
 * `{ action, evidence, score }`.
 */
export async function matchCompletions({ store, noteId, content, now, timeZone, vectors = null, ask = null, open, maxQuestions = MAX_QUESTIONS_PER_NOTE }) {
  const out = { completed: [], suggested: [], asked: 0 }
  const candidates = detectActionCandidates(content, { now, timeZone }).filter((candidate) => candidate.kindHint === 'completion')
  if (!candidates.length || !open.length) return out
  const embeddings = await vectors?.([...candidates.map((candidate) => candidate.text), ...open.map((action) => action.text)])
  for (const candidate of candidates) {
    const hit = findCompletion({ text: candidate.text, person: candidate.person, checked: candidate.signals?.includes('checkbox') }, open, { embeddings, now })
    if (!hit) continue
    const key = quoteKey(candidate.text)
    if ((hit.action.completionDismissed ?? []).includes(key)) continue
    if (hit.ambiguous) {
      if (!ask || out.asked >= maxQuestions) continue
      out.asked += 1
      if (!(await ask(candidate.text, hit.action.text))) continue
    }
    const evidence = { noteId, quote: candidate.text.trim(), from: candidate.from, to: candidate.to, score: hit.score, at: now.toISOString() }
    const result = hit.auto ? store.completeFromEvidence(hit.action.id, evidence) : store.suggestCompletion(hit.action.id, evidence)
    if (!result) continue
    ;(hit.auto ? out.completed : out.suggested).push({ action: result, evidence, score: hit.score })
    // The action is no longer open (or already has its suggestion): later sentences must not pick it again.
    if (hit.auto) open = open.filter((action) => action.id !== hit.action.id)
  }
  return out
}

/** Builds the `ask` function the service and the eval pass to matchCompletions. */
export const askWith = (generate) => (generate ? (sentence, task) => askCompletion(generate, sentence, task) : null)

/**
 * The whole matching step for one processed note, in the order the service runs it: repeats are merged into open
 * actions, what is left is added, then completion sentences are matched against the open actions. A failure in either
 * matching half is logged and leaves the plain extraction result in place.
 * Resolves to `{ merged, dropped, added, completions }`.
 */
export async function applyNoteMatching({ store, noteId, content, items, noteVersion = null, at, timeZone, vectors = null, ask = null }) {
  let merged = []
  let dropped = []
  let rest = items
  try {
    ;({ merged, rest, dropped } = await mergeRepeats({ store, noteId, items, noteVersion, vectors, open: store.openForMatching() }))
  } catch (error) {
    console.error(`Repeat matching of ${noteId} failed. ${error.message}`)
    rest = items
  }
  const added = await store.addFromExtraction(noteId, rest, { noteVersion, at })
  let completions = { completed: [], suggested: [], asked: 0 }
  try {
    completions = await matchCompletions({ store, noteId, content, now: at, timeZone, vectors, ask, open: store.openForMatching() })
  } catch (error) {
    console.error(`Completion matching of ${noteId} failed. ${error.message}`)
  }
  return { merged, dropped, added, completions }
}
