// Pure evaluation helpers for action extraction (issue #18). No stage-specific logic lives here
// except the stage registry at the bottom. The conventions behind the labels are documented in
// test/fixtures/action-eval/README.md.

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const KINDS = ['task', 'my-commitment', 'waiting-on', 'follow-up', 'event']
export const LANGUAGES = ['en', 'no', 'mixed']
export const SOURCES = ['note', 'transcript', 'capture']
export const FIELDS = ['kind', 'person', 'due', 'explicit']

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export const defaultCasesPath = fileURLToPath(new URL('../../test/fixtures/action-eval/cases.json', import.meta.url))
export const holdoutCasesPath = fileURLToPath(new URL('../../test/fixtures/action-eval/cases-holdout.json', import.meta.url))
export const baselinePathFor = (stage, { holdout = false } = {}) => fileURLToPath(new URL(`../../test/fixtures/action-eval/baseline-${stage}${holdout ? '-holdout' : ''}.json`, import.meta.url))

// ---------------------------------------------------------------- dataset

export async function loadCases(filePath = defaultCasesPath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain a JSON array of cases.`)
  return parsed
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function dueProblem(due) {
  if (due === null) return null
  if (!due || typeof due !== 'object' || Array.isArray(due)) return 'due must be null or an object'
  if (due.window !== undefined) {
    const { start, end } = due.window || {}
    if (Object.keys(due).length !== 1) return 'a window due must not have other keys'
    if (!isRealDate(start) || !isRealDate(end)) return 'window needs valid start and end dates (YYYY-MM-DD)'
    if (start > end) return 'window start is after its end'
    return null
  }
  if (!isRealDate(due.date)) return 'due.date must be a valid YYYY-MM-DD date'
  if (due.time !== undefined && !TIME_PATTERN.test(due.time)) return 'due.time must be HH:MM'
  const extra = Object.keys(due).filter((key) => key !== 'date' && key !== 'time')
  return extra.length ? `unexpected due keys: ${extra.join(', ')}` : null
}

function occurrences(content, quote) {
  if (!quote) return 0
  let count = 0
  for (let index = content.indexOf(quote); index !== -1; index = content.indexOf(quote, index + 1)) count += 1
  return count
}

/** Returns a list of human-readable problems; an empty list means the dataset is valid. */
export function validateCases(cases) {
  const problems = []
  if (!Array.isArray(cases)) return ['cases must be an array']
  const ids = new Set()
  cases.forEach((item, position) => {
    const label = typeof item?.id === 'string' && item.id ? item.id : `#${position}`
    const problem = (message) => problems.push(`${label}: ${message}`)
    if (!item || typeof item !== 'object') return problem('case must be an object')
    if (typeof item.id !== 'string' || !item.id) problem('id must be a non-empty string')
    else if (ids.has(item.id)) problem('duplicate id')
    else ids.add(item.id)
    if (!LANGUAGES.includes(item.language)) problem(`language must be one of ${LANGUAGES.join(', ')}`)
    if (!SOURCES.includes(item.source)) problem(`source must be one of ${SOURCES.join(', ')}`)
    if (typeof item.now !== 'string' || Number.isNaN(Date.parse(item.now))) problem('now must be an ISO date-time string')
    if (typeof item.timeZone !== 'string' || !item.timeZone) problem('timeZone must be a string')
    if (typeof item.content !== 'string' || !item.content) problem('content must be a non-empty string')
    if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string' || !tag)) problem('tags must be an array of strings')
    if (!Array.isArray(item.expected)) return problem('expected must be an array')
    const content = typeof item.content === 'string' ? item.content : ''
    const spans = []
    item.expected.forEach((expected, index) => {
      const where = `expected[${index}]`
      if (!expected || typeof expected !== 'object') return problem(`${where} must be an object`)
      if (typeof expected.quote !== 'string' || !expected.quote) return problem(`${where}.quote must be a non-empty string`)
      const count = occurrences(content, expected.quote)
      if (count !== 1) problem(`${where}.quote must appear exactly once in content (found ${count}): ${JSON.stringify(expected.quote)}`)
      else spans.push([content.indexOf(expected.quote), content.indexOf(expected.quote) + expected.quote.length, where])
      if (!KINDS.includes(expected.kind)) problem(`${where}.kind must be one of ${KINDS.join(', ')}`)
      if (expected.person !== null && (typeof expected.person !== 'string' || !expected.person)) problem(`${where}.person must be null or a name`)
      const due = dueProblem(expected.due)
      if (due) problem(`${where}.${due}`)
      if (typeof expected.explicit !== 'boolean') problem(`${where}.explicit must be a boolean`)
    })
    spans.sort((left, right) => left[0] - right[0])
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index][0] < spans[index - 1][1]) problem(`${spans[index - 1][2]} and ${spans[index][2]} overlap`)
    }
    if (item.completions !== undefined) {
      if (!Array.isArray(item.completions)) return problem('completions must be an array')
      item.completions.forEach((completion, index) => {
        const count = occurrences(content, completion?.quote)
        if (count !== 1) problem(`completions[${index}].quote must appear exactly once in content (found ${count})`)
      })
    }
  })
  return problems
}

// ---------------------------------------------------------------- matching

function expectedSpan(caseItem, expected) {
  const from = caseItem.content.indexOf(expected.quote)
  return { from, to: from + expected.quote.length }
}

/**
 * Pairs predictions with expected actions one-to-one. A prediction matches when its [from, to)
 * range overlaps the expected quote's range; the largest overlaps are paired first.
 */
export function matchPredictions(caseItem, predictions) {
  const list = Array.isArray(predictions) ? predictions : []
  const candidates = []
  caseItem.expected.forEach((expected, expectedIndex) => {
    const span = expectedSpan(caseItem, expected)
    list.forEach((prediction, predictionIndex) => {
      const overlap = Math.min(span.to, prediction.to) - Math.max(span.from, prediction.from)
      if (overlap > 0) candidates.push({ expectedIndex, predictionIndex, overlap })
    })
  })
  candidates.sort((left, right) => right.overlap - left.overlap || left.expectedIndex - right.expectedIndex || left.predictionIndex - right.predictionIndex)
  const usedExpected = new Set()
  const usedPredictions = new Set()
  const truePositives = []
  for (const candidate of candidates) {
    if (usedExpected.has(candidate.expectedIndex) || usedPredictions.has(candidate.predictionIndex)) continue
    usedExpected.add(candidate.expectedIndex)
    usedPredictions.add(candidate.predictionIndex)
    truePositives.push({ expected: caseItem.expected[candidate.expectedIndex], prediction: list[candidate.predictionIndex] })
  }
  return {
    truePositives,
    falsePositives: list.filter((_, index) => !usedPredictions.has(index)),
    falseNegatives: caseItem.expected.filter((_, index) => !usedExpected.has(index)),
  }
}

// ---------------------------------------------------------------- field comparison

/** Maps a detector `time` object to the dataset's due shape (null, {date}, {date,time} or {window}). */
export function normalizeDue(time) {
  if (!time) return null
  if (time.window?.start && time.window?.end) return { window: { start: time.window.start, end: time.window.end } }
  if (time.date && time.time) return { date: time.date, time: time.time }
  if (time.date) return { date: time.date }
  return null
}

function sameDue(left, right) {
  return JSON.stringify(normalizeDue(left)) === JSON.stringify(normalizeDue(right))
}

function samePerson(expected, predicted) {
  if (expected === null || expected === undefined) return predicted === null || predicted === undefined
  return typeof predicted === 'string' && predicted.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase()
}

export function compareFields(expected, prediction) {
  return {
    kind: (prediction.kindHint ?? null) === expected.kind,
    person: samePerson(expected.person, prediction.person),
    due: sameDue(expected.due, prediction.time),
    explicit: Boolean(prediction.explicit) === expected.explicit,
  }
}

// ---------------------------------------------------------------- scoring

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)

function prf({ tp, fp, fn }) {
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : (tp + fp + fn > 0 ? 0 : null)
  return { tp, fp, fn, precision, recall, f1 }
}

const emptyCounts = () => ({ tp: 0, fp: 0, fn: 0 })
function addCounts(target, source) { target.tp += source.tp; target.fp += source.fp; target.fn += source.fn }

function describePrediction(caseItem, prediction) {
  return {
    text: typeof prediction.text === 'string' ? prediction.text : caseItem.content.slice(prediction.from, prediction.to),
    from: prediction.from,
    to: prediction.to,
    score: prediction.score ?? null,
    explicit: Boolean(prediction.explicit),
    signals: prediction.signals ?? [],
  }
}

/**
 * Runs `predictFn(caseItem)` (sync or async, returning detector-shaped predictions) over every
 * case and returns metrics plus per-case details. `completion` stage extras can add their own
 * sections to the result; the keys below are the stable contract used by baselines.
 */
export async function scoreStage(cases, predictFn) {
  const overall = emptyCounts()
  const byLanguage = new Map()
  const bySource = new Map()
  const byTag = new Map()
  const fieldTotals = Object.fromEntries(FIELDS.map((field) => [field, { correct: 0, total: 0 }]))
  const explicit = { predicted: 0, correct: 0 }
  const completions = emptyCounts()
  const details = []
  const started = performance.now()

  for (const caseItem of cases) {
    const allPredictions = (await predictFn(caseItem)) ?? []
    // Completion candidates (kindHint 'completion') are scored separately against `completions`.
    const predictions = allPredictions.filter((prediction) => prediction.kindHint !== 'completion')
    const completionMatch = matchPredictions(
      { content: caseItem.content, expected: (caseItem.completions ?? []).map((completion) => ({ quote: completion.quote })) },
      allPredictions.filter((prediction) => prediction.kindHint === 'completion'),
    )
    addCounts(completions, { tp: completionMatch.truePositives.length, fp: completionMatch.falsePositives.length, fn: completionMatch.falseNegatives.length })
    const match = matchPredictions(caseItem, predictions)
    const counts = { tp: match.truePositives.length, fp: match.falsePositives.length, fn: match.falseNegatives.length }
    addCounts(overall, counts)
    for (const [map, keys] of [[byLanguage, [caseItem.language]], [bySource, [caseItem.source]], [byTag, caseItem.tags ?? []]]) {
      for (const key of keys) {
        if (!map.has(key)) map.set(key, { ...emptyCounts(), cases: 0 })
        const entry = map.get(key)
        addCounts(entry, counts)
        entry.cases += 1
      }
    }
    const fieldMismatches = []
    for (const { expected, prediction } of match.truePositives) {
      const result = compareFields(expected, prediction)
      for (const field of FIELDS) {
        fieldTotals[field].total += 1
        if (result[field]) fieldTotals[field].correct += 1
        else fieldMismatches.push({ quote: expected.quote, field, expected: field === 'kind' ? expected.kind : expected[field], actual: field === 'kind' ? prediction.kindHint ?? null : field === 'due' ? normalizeDue(prediction.time) : field === 'person' ? prediction.person ?? null : Boolean(prediction.explicit) })
      }
    }
    const matchedPredictions = new Set(match.truePositives.map((pair) => pair.prediction))
    const explicitFalsePositives = []
    for (const prediction of predictions) {
      if (!prediction.explicit) continue
      explicit.predicted += 1
      const pair = match.truePositives.find((candidate) => candidate.prediction === prediction)
      if (pair?.expected.explicit) explicit.correct += 1
      else if (!matchedPredictions.has(prediction)) explicitFalsePositives.push(describePrediction(caseItem, prediction))
    }
    details.push({
      id: caseItem.id,
      language: caseItem.language,
      source: caseItem.source,
      tags: caseItem.tags ?? [],
      ...counts,
      falsePositives: match.falsePositives.map((prediction) => describePrediction(caseItem, prediction)),
      falseNegatives: match.falseNegatives.map((expected) => ({ quote: expected.quote, kind: expected.kind, explicit: expected.explicit })),
      fieldMismatches,
      explicitFalsePositives,
      completionFalsePositives: completionMatch.falsePositives.map((prediction) => describePrediction(caseItem, prediction)),
      completionFalseNegatives: completionMatch.falseNegatives.map((missed) => ({ quote: missed.quote })),
    })
  }

  const group = (map) => Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, { cases: entry.cases, ...prf(entry) }]))
  return {
    cases: cases.length,
    expected: cases.reduce((sum, item) => sum + item.expected.length, 0),
    predictions: overall.tp + overall.fp,
    elapsedMs: Math.round(performance.now() - started),
    overall: prf(overall),
    byLanguage: group(byLanguage),
    bySource: group(bySource),
    byTag: group(byTag),
    fieldAccuracy: Object.fromEntries(FIELDS.map((field) => [field, { ...fieldTotals[field], accuracy: ratio(fieldTotals[field].correct, fieldTotals[field].total) }])),
    completions: prf(completions),
    explicitPrecision: { ...explicit, precision: ratio(explicit.correct, explicit.predicted) },
    details,
  }
}

// ---------------------------------------------------------------- baselines

const round4 = (value) => (typeof value === 'number' ? Math.round(value * 10_000) / 10_000 : value)
function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundDeep(entry)]))
  return round4(value)
}

/** The stored baseline: metrics without per-case details, plus stage, date and optional model/prompt ids. */
export function createBaseline(stage, metrics, { date = new Date().toISOString(), modelId, promptVersion } = {}) {
  const { details: _details, elapsedMs: _elapsed, ...rest } = metrics
  return {
    stage,
    date,
    ...(modelId ? { modelId } : {}),
    ...(promptVersion ? { promptVersion } : {}),
    metrics: roundDeep(rest),
  }
}

export async function loadBaseline(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Metric paths that are compared against a baseline. Each returns a number or null. */
function trackedMetrics(metrics) {
  const tracked = {
    'overall.precision': metrics.overall?.precision,
    'overall.recall': metrics.overall?.recall,
    'overall.f1': metrics.overall?.f1,
    'explicitPrecision.precision': metrics.explicitPrecision?.precision,
    'routing.suggestionPrecision': metrics.routing?.suggestionPrecision,
    'routing.suggestionRecall': metrics.routing?.suggestionRecall,
    'completions.precision': metrics.completions?.precision,
    'completions.recall': metrics.completions?.recall,
  }
  for (const field of FIELDS) tracked[`fieldAccuracy.${field}`] = metrics.fieldAccuracy?.[field]?.accuracy
  for (const [language, entry] of Object.entries(metrics.byLanguage ?? {})) {
    tracked[`byLanguage.${language}.precision`] = entry.precision
    tracked[`byLanguage.${language}.recall`] = entry.recall
  }
  return tracked
}

/**
 * Compares current metrics with a stored baseline (either the whole baseline file or just its
 * metrics). Every tracked metric present in both yields `{ metric, baseline, current, delta,
 * status }` where status is `regression` (dropped by more than `tolerance`), `improvement`
 * (rose by more than `tolerance`) or `unchanged`.
 */
export function compareToBaseline(metrics, baseline, { tolerance = 0.02 } = {}) {
  const before = trackedMetrics(baseline?.metrics ?? baseline ?? {})
  const after = trackedMetrics(metrics)
  const entries = []
  for (const [metric, current] of Object.entries(after)) {
    const previous = before[metric]
    if (typeof current !== 'number' || typeof previous !== 'number') continue
    const delta = current - previous
    const status = delta < -tolerance - 1e-9 ? 'regression' : delta > tolerance + 1e-9 ? 'improvement' : 'unchanged'
    entries.push({ metric, baseline: previous, current, delta, status })
  }
  return entries
}

// ---------------------------------------------------------------- stage registry

const detectorUrl = new URL('../../server/actions/detector.js', import.meta.url)
export const detectorPath = fileURLToPath(detectorUrl)

// ACTION_EVAL_DETECTOR points the stage at another module exporting detectActionCandidates (for experiments).
const detectorOverride = () => (process.env.ACTION_EVAL_DETECTOR ? path.resolve(process.env.ACTION_EVAL_DETECTOR) : null)

function notImplemented(stage, issue) {
  return async () => { throw new Error(`The "${stage}" stage is not implemented yet (see ${issue}).`) }
}

/**
 * Stage registry. A stage is `{ description, local, load }` where `load()` resolves to
 * `predictFn(caseItem) => predictions` in the detector's output shape (`from`, `to`, `explicit`,
 * `kindHint`, `person`, `time`, ...), so scoreStage works unchanged.
 *
 * Extension points:
 * - `model` (#17): see action-eval-model.js. Runs the full extraction pipeline against a real MLX service and
 *   maps the final items to this shape. It is `local: true` and stays out of `npm test`.
 * - `completion` (#21): will need its own scorer for completion/duplicate matching using
 *   `caseItem.completions`; register it here and give it a dedicated scoring function.
 */
export const stages = {
  detector: {
    description: 'Deterministic candidate detector and date parser (#16)',
    local: false,
    available: () => existsSync(detectorOverride() ?? detectorPath),
    async load() {
      const modulePath = detectorOverride() ?? detectorPath
      if (!existsSync(modulePath)) throw Object.assign(new Error('The detector is not available yet: server/actions/detector.js does not exist (see #16).'), { code: 'STAGE_UNAVAILABLE' })
      const { detectActionCandidates } = await import(pathToFileURL(modulePath).href)
      return (caseItem) => detectActionCandidates(caseItem.content, { now: new Date(caseItem.now), timeZone: caseItem.timeZone })
    },
  },
  model: {
    description: 'Gemma micro-task extraction on top of the detector (#17); local only, needs MLX models',
    local: true,
    available: () => true,
    // Starts the MLX helper, so it is imported lazily and never by `npm test`.
    load: async (options = {}) => (await import('./action-eval-model.js')).loadModelStage(options),
  },
  completion: {
    description: 'Completion and duplicate matching (#21)',
    local: false,
    available: () => false,
    load: notImplemented('completion', '#21'),
  },
}
