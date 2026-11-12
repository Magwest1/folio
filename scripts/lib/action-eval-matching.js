// Matching stage of the action evaluation (issue #21). Each scenario is a short sequence of notes written over time.
// It is replayed through the real pipeline pieces: note by note, extraction (the deterministic detector by default,
// Gemma with --model), then the same repeat and completion matching the action service runs, against a real action
// store in a temporary directory whose clock follows the notes. The result is scored against what a person would say:
// which later passages repeat which earlier commitments, which finish them, and which must stay closed.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectActionCandidates } from '../../server/actions/detector.js'
import { createActionStore } from '../../server/actions/store.js'
import { normalizePassage } from '../../server/actions/fingerprint.js'
import { applyNoteMatching, createVectorCache } from '../../server/actions/matching/apply.js'
import { hashContent } from '../../server/actions/service.js'
import { normalizeDue } from './action-eval.js'

export const matchingCasesPath = fileURLToPath(new URL('../../test/fixtures/action-eval/matching-cases.json', import.meta.url))
export const matchingHoldoutPath = fileURLToPath(new URL('../../test/fixtures/action-eval/matching-cases-holdout.json', import.meta.url))
export const matchingBaselinePath = (holdout = false) => fileURLToPath(new URL(`../../test/fixtures/action-eval/baseline-matching${holdout ? '-holdout' : ''}.json`, import.meta.url))

const OPS = ['let-go', 'reject', 'done', 'undo', 'dismiss-completion']
const KINDS = ['task', 'my-commitment', 'waiting-on', 'follow-up', 'event']
const OPEN = ['open', 'suggested', 'snoozed']
/** Detector candidates need at least this score to count as extracted items when no model is involved. */
export const DETERMINISTIC_ITEM_SCORE = 0.45
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)
const norm = (value) => normalizePassage(value)

export async function loadMatchingCases(filePath = matchingCasesPath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array of scenarios.`)
  return parsed
}

const count = (text, quote) => (quote ? text.split(quote).length - 1 : 0)

export function validateMatchingCases(cases) {
  const problems = []
  if (!Array.isArray(cases)) return ['scenarios must be an array']
  const ids = new Set()
  for (const [position, item] of cases.entries()) {
    const label = typeof item?.id === 'string' && item.id ? item.id : `#${position}`
    const problem = (message) => problems.push(`${label}: ${message}`)
    if (!item || typeof item !== 'object') { problem('scenario must be an object'); continue }
    if (!item.id || ids.has(item.id)) problem('id must be unique and non-empty')
    ids.add(item.id)
    if (!['en', 'no', 'mixed'].includes(item.language)) problem('language must be en, no or mixed')
    if (Number.isNaN(Date.parse(item.now)) || !item.timeZone) problem('now and timeZone are required')
    if (!Array.isArray(item.tags)) problem('tags must be an array')
    if (!Array.isArray(item.notes) || !item.notes.length) { problem('notes must be a non-empty array'); continue }
    let last = 0
    for (const note of item.notes) {
      if (!note.id?.startsWith('/') || typeof note.content !== 'string' || !note.content.trim()) problem(`note ${note.id} needs an id starting with / and content`)
      const at = Date.parse(note.at)
      if (Number.isNaN(at) || at < last) problem(`note ${note.id} needs an ISO "at" that does not go back in time`)
      last = at
    }
    // A quote must appear exactly once in at least one version of its note.
    const located = (reference, where) => {
      const versions = item.notes.filter((note) => note.id === reference?.noteId)
      if (!versions.length) return problem(`${where}: unknown note ${reference?.noteId}`)
      if (!versions.some((note) => count(note.content, reference.quote) === 1)) problem(`${where}: quote must appear exactly once in ${reference.noteId}: ${JSON.stringify(reference.quote)}`)
    }
    const expected = item.expected ?? {}
    for (const [index, entry] of (expected.repeats ?? []).entries()) { located(entry, `repeats[${index}]`); located(entry.sameAs, `repeats[${index}].sameAs`) }
    for (const [index, entry] of (expected.completions ?? []).entries()) {
      located(entry, `completions[${index}]`); located(entry.completes, `completions[${index}].completes`)
      if (typeof entry.auto !== 'boolean') problem(`completions[${index}].auto must be a boolean`)
    }
    for (const key of ['stayClosed', 'created']) for (const [index, entry] of (expected[key] ?? []).entries()) located(entry, `${key}[${index}]`)
    for (const [index, action] of (item.userActions ?? []).entries()) {
      if (!Number.isInteger(action.after) || !item.notes[action.after]) problem(`userActions[${index}].after must be a note index`)
      if (!OPS.includes(action.op) || !action.quote) problem(`userActions[${index}] needs op (${OPS.join(', ')}) and quote`)
    }
  }
  return problems
}

// ---------------------------------------------------------------- extraction

const cleanText = (text) => text.replace(/^[\s>*_~-]*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/, '').trim().slice(0, 140)

/** Detector candidates as extraction items: no model, so the candidate's own score decides what counts as an item. */
export function deterministicItems(content, { now, timeZone }) {
  return detectActionCandidates(content, { now, timeZone })
    .filter((candidate) => candidate.kindHint !== 'completion' && (candidate.explicit || candidate.score >= DETERMINISTIC_ITEM_SCORE))
    .map((candidate) => ({
      text: cleanText(candidate.text), kind: KINDS.includes(candidate.kindHint) ? candidate.kindHint : 'task', person: candidate.person ?? null,
      due: normalizeDue(candidate.time), confidence: candidate.score, explicit: candidate.explicit, status: candidate.explicit ? 'open' : 'suggested',
      origin: candidate.explicit ? 'auto' : 'suggested', signals: candidate.signals,
      anchor: { from: candidate.from, to: candidate.to, quote: content.slice(candidate.from, candidate.to) },
    }))
}

// ---------------------------------------------------------------- replay

const overlaps = (noteId, text, reference) => noteId === reference.noteId && Boolean(norm(text)) && (norm(text).includes(norm(reference.quote)) || norm(reference.quote).includes(norm(text)))
const anchorsOf = (action) => [action.anchor, ...(action.anchors ?? [])].filter((anchor) => anchor?.noteId)

function findTarget(store, quote) {
  const wanted = norm(quote)
  return store.list({ includeClosed: true }).find((action) => anchorsOf(action).some((anchor) => norm(anchor.quote).includes(wanted)) || norm(action.text).includes(wanted))
}

/**
 * Replays one scenario. `extract(note, { now, timeZone }) -> items` is async; `vectors` and `ask` are the optional model
 * helpers. Resolves to the events the matching produced and the final store state.
 */
export async function replayScenario(scenario, { extract = async (note, context) => deterministicItems(note.content, context), vectors = null, ask = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-matching-eval-'))
  let clock = new Date(scenario.notes[0].at)
  const store = createActionStore({ filePath: path.join(dir, 'actions.json'), now: () => clock })
  const events = { repeats: [], completions: [], dropped: [], reapplied: [] }
  const closedByUser = new Map()
  const blocked = new Set()
  try {
    for (const [index, note] of scenario.notes.entries()) {
      clock = new Date(note.at)
      store.reanchor(note.id, note.content)
      const items = await extract(note, { now: clock, timeZone: scenario.timeZone })
      const result = await applyNoteMatching({
        store, noteId: note.id, content: note.content, items, noteVersion: hashContent(note.content), at: clock, timeZone: scenario.timeZone, vectors, ask,
      })
      for (const { item, action } of result.merged) {
        events.repeats.push({ noteId: note.id, text: item.anchor.quote, targets: anchorsOf(action).filter((anchor) => !(anchor.noteId === note.id && norm(anchor.quote) === norm(item.anchor.quote))) })
      }
      events.dropped.push(...result.dropped.map((item) => ({ noteId: note.id, text: item.anchor?.quote ?? item.text })))
      for (const [auto, list] of [[true, result.completions.completed], [false, result.completions.suggested]]) {
        for (const { action, evidence } of list) {
          events.completions.push({ noteId: note.id, text: evidence.quote, auto, targets: [action.anchor].filter(Boolean), actionId: action.id })
          if (blocked.has(`${action.id}:${norm(evidence.quote)}`)) events.reapplied.push({ noteId: note.id, quote: evidence.quote })
        }
      }
      for (const step of (scenario.userActions ?? []).filter((entry) => entry.after === index)) {
        const target = findTarget(store, step.quote)
        if (!target) continue
        if (step.op === 'let-go') store.letGo(target.id)
        else if (step.op === 'reject') store.reject(target.id)
        else if (step.op === 'done') store.complete(target.id)
        else if (step.op === 'undo') {
          const evidence = target.completion?.quote
          store.undo(target.id)
          if (evidence) blocked.add(`${target.id}:${norm(evidence)}`)
        } else if (step.op === 'dismiss-completion') {
          if (target.completionSuggestion) blocked.add(`${target.id}:${norm(target.completionSuggestion.quote)}`)
          store.dismissCompletion(target.id)
        }
        if (['let-go', 'reject', 'done'].includes(step.op)) closedByUser.set(target.id, store.get(target.id).status)
      }
    }
    const finalActions = store.list({ includeClosed: true })
    return { events, finalActions, closedByUser }
  } finally {
    await store.flush().catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- scoring

const empty = () => ({ tp: 0, fp: 0, fn: 0 })
function prf({ tp, fp, fn }) {
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  return { tp, fp, fn, precision, recall, f1: precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null }
}
const add = (target, source) => { target.tp += source.tp; target.fp += source.fp; target.fn += source.fn }

/** Pairs predictions with expected entries one to one; a prediction counts only when it names the right earlier passage. */
function pair(predictions, expectedList, targetOf) {
  const used = new Set()
  const hits = []
  const misses = []
  for (const expected of expectedList) {
    const index = predictions.findIndex((prediction, at) => !used.has(at) && overlaps(prediction.noteId, prediction.text, expected)
      && prediction.targets.some((anchor) => overlaps(anchor.noteId, anchor.quote, targetOf(expected))))
    if (index === -1) misses.push(expected)
    else { used.add(index); hits.push({ expected, prediction: predictions[index] }) }
  }
  return { hits, misses, extras: predictions.filter((_, index) => !used.has(index)) }
}

export function scoreScenario(scenario, replay) {
  const expected = scenario.expected ?? {}
  const repeats = pair(replay.events.repeats, expected.repeats ?? [], (entry) => entry.sameAs)
  const completions = pair(replay.events.completions, expected.completions ?? [], (entry) => entry.completes)
  const openAnchors = replay.finalActions.filter((action) => OPEN.includes(action.status))
  const resurrected = (expected.stayClosed ?? []).filter((reference) => openAnchors.some((action) => anchorsOf(action).some((anchor) => overlaps(anchor.noteId, anchor.quote, reference))))
  const reopened = [...replay.closedByUser].filter(([id, status]) => replay.finalActions.find((action) => action.id === id)?.status !== status)
  const created = (expected.created ?? []).filter((reference) => openAnchors.some((action) => action.anchor && overlaps(action.anchor.noteId, action.anchor.quote, reference)))
  const autoPredicted = replay.events.completions.filter((event) => event.auto)
  const autoHits = completions.hits.filter(({ prediction }) => prediction.auto)
  return {
    id: scenario.id, language: scenario.language, tags: scenario.tags,
    repeats: { tp: repeats.hits.length, fp: repeats.extras.length, fn: repeats.misses.length },
    completions: { tp: completions.hits.length, fp: completions.extras.length, fn: completions.misses.length },
    auto: { predicted: autoPredicted.length, correct: autoHits.length, expected: (expected.completions ?? []).filter((entry) => entry.auto).length, found: autoHits.filter(({ expected: entry }) => entry.auto).length },
    wrongResurrections: resurrected.length + reopened.length + replay.events.reapplied.length,
    created: { expected: (expected.created ?? []).length, found: created.length },
    errors: {
      repeatFalsePositives: repeats.extras.map((event) => ({ note: event.noteId, text: event.text, targets: event.targets.map((anchor) => anchor.quote) })),
      repeatMisses: repeats.misses.map((entry) => entry.quote),
      completionFalsePositives: completions.extras.map((event) => ({ note: event.noteId, text: event.text, auto: event.auto })),
      completionMisses: completions.misses.map((entry) => entry.quote),
      resurrected: resurrected.map((reference) => reference.quote), reopened: reopened.map(([id]) => id), reapplied: replay.events.reapplied,
      notCreated: (expected.created ?? []).filter((reference) => !created.includes(reference)).map((reference) => reference.quote),
      autoNotExpected: autoHits.filter(({ expected: entry }) => !entry.auto).map(({ prediction }) => prediction.text),
    },
  }
}

/** Metrics over scenarios. `runner(scenario)` resolves to a replay; the default replays with the deterministic extractor. */
export async function scoreMatching(scenarios, runner = (scenario) => replayScenario(scenario)) {
  const totals = { repeats: empty(), completions: empty() }
  const auto = { predicted: 0, correct: 0, expected: 0, found: 0 }
  const created = { expected: 0, found: 0 }
  const groups = { language: new Map(), tag: new Map() }
  let wrongResurrections = 0
  const details = []
  const started = performance.now()
  for (const scenario of scenarios) {
    const result = scoreScenario(scenario, await runner(scenario))
    details.push(result)
    add(totals.repeats, result.repeats)
    add(totals.completions, result.completions)
    for (const key of Object.keys(auto)) auto[key] += result.auto[key]
    created.expected += result.created.expected
    created.found += result.created.found
    wrongResurrections += result.wrongResurrections
    for (const [map, keys] of [[groups.language, [scenario.language]], [groups.tag, scenario.tags ?? []]]) {
      for (const key of keys) {
        if (!map.has(key)) map.set(key, { scenarios: 0, errors: 0 })
        const entry = map.get(key)
        entry.scenarios += 1
        entry.errors += result.repeats.fp + result.repeats.fn + result.completions.fp + result.completions.fn + result.wrongResurrections + (result.created.expected - result.created.found)
      }
    }
  }
  const group = (map) => Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)))
  return {
    scenarios: scenarios.length,
    elapsedMs: Math.round(performance.now() - started),
    matching: {
      repeats: prf(totals.repeats),
      completions: prf(totals.completions),
      autoCompletion: { ...auto, precision: ratio(auto.correct, auto.predicted), recall: ratio(auto.found, auto.expected) },
      wrongResurrections,
      created: { ...created, rate: ratio(created.found, created.expected) },
    },
    byLanguage: group(groups.language), byTag: group(groups.tag), details,
  }
}

export { createVectorCache }

/**
 * The matching stage loader used by the stage registry. Deterministic by default (detector items, lexical matching);
 * `model: true` replays with the real Gemma extraction, embeddings and the yes/no question (local only).
 */
export async function loadMatchingStage({ model = false, modelId } = {}) {
  if (!model) {
    const replay = (scenario) => replayScenario(scenario)
    replay.summary = () => ({ mode: 'deterministic' })
    return replay
  }
  return (await import('./action-eval-matching-model.js')).loadMatchingModelStage({ modelId })
}
