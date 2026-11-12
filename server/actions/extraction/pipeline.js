// Action extraction pipeline: detector candidates -> optional embedding filter -> one grounded Gemma
// micro-task per span -> deterministic kind, due and confidence -> routing (auto / suggested / dropped).
// The model is injected (`generate`, `embed`) so the pipeline is testable and runs the same in the eval script.
import { detectActionCandidates } from '../detector.js'
import {
  AUTO_THRESHOLD, BORDERLINE_HIGH, BORDERLINE_LOW, SUGGEST_THRESHOLD, computeConfidence, sampleAgreement,
} from './confidence.js'
import { filterByEmbedding } from './embedding-filter.js'
import { dueOf, groundOutput, groundPerson } from './grounding.js'
import { deriveKind } from './kind.js'
import { ActionOutputError, parseSpanOutput } from './parse.js'
import { PROMPT_VERSION, buildSpanMessages, detectLanguage } from './prompt.js'

export { AUTO_THRESHOLD, SUGGEST_THRESHOLD, PROMPT_VERSION }

const DEFAULTS = { maxExtraCalls: 4, extraSamples: 2, extraTemperature: 0.4, maxTokens: 96, timeoutMs: 120_000, embeddingFilter: true }
const MARKER_SIGNALS = ['checkbox', 'todo-marker']
const now = () => performance.now()
const ms = (start) => Math.round(now() - start)
const SENTENCE_END = /(?<=[.!?])\s+/

function sentenceBefore(content, from) {
  const lines = content.slice(0, from).split('\n').map((line) => line.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').split(SENTENCE_END).at(-1).slice(-240)
}

function sentenceAfter(content, to) {
  const line = content.slice(to).split('\n').map((value) => value.trim()).find(Boolean) ?? ''
  return line.split(SENTENCE_END)[0].slice(0, 240)
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The model call timed out.'), { reason: 'timeout' })), timeoutMs) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const cleanText = (text) => text.replace(/^[\s>*_~-]*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/, '').trim().slice(0, 140)
const sameDue = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function makeItem(candidate, content, fields, { modelId, extraSignals = [] }) {
  return {
    text: fields.text,
    kind: fields.kind,
    person: fields.person ?? null,
    due: fields.due ?? null,
    confidence: fields.confidence,
    explicit: candidate.explicit,
    status: fields.auto ? 'open' : 'suggested',
    origin: fields.auto ? 'auto' : 'suggested',
    anchor: { from: candidate.from, to: candidate.to, quote: content.slice(candidate.from, candidate.to) },
    signals: [...candidate.signals, ...extraSignals],
    promptVersion: PROMPT_VERSION,
    modelId: modelId ?? null,
    groundingIssues: fields.issues ?? [],
  }
}

/**
 * Extracts actions from `content`. `generate(messages, { maxTokens, temperature })` resolves to `{ text, modelId? }`
 * (optionally `tokenProbability`); `embed(texts)` resolves to vectors. Returns `{ items, dropped, stats }`.
 */
export async function extractActions({ content, noteId = null, now: at = new Date(), timeZone = 'UTC', generate, embed = null, examples = [], options = {} }) {
  const settings = { ...DEFAULTS, ...options }
  const started = now()
  const source = String(content ?? '')
  const items = []
  const dropped = []
  const stats = { noteId, candidates: 0, embeddingDropped: 0, modelCalls: 0, extraCalls: 0, degraded: [], dropReasons: {}, timing: { detectMs: 0, embedMs: 0, modelMs: 0, totalMs: 0 } }
  let modelId = settings.modelId ?? null
  let extraBudget = settings.maxExtraCalls

  const drop = (candidate, reason, detail = null) => {
    stats.dropReasons[reason] = (stats.dropReasons[reason] ?? 0) + 1
    dropped.push({ from: candidate.from, to: candidate.to, quote: source.slice(candidate.from, candidate.to), reason, detail })
  }

  let t = now()
  let candidates = detectActionCandidates(source, { now: at, timeZone }).filter((candidate) => candidate.kindHint !== 'completion')
  stats.timing.detectMs = ms(t)
  stats.candidates = candidates.length

  if (embed && settings.embeddingFilter !== false && candidates.length) {
    t = now()
    try {
      const result = await filterByEmbedding(candidates, embed)
      candidates = result.kept
      stats.embeddingDropped = result.dropped.length
      for (const { candidate, margin } of result.dropped) drop(candidate, 'embedding-non-action', margin)
    } catch (error) {
      stats.embeddingError = error.message
    }
    stats.timing.embedMs = ms(t)
  }

  async function call(messages, temperature) {
    const response = await withTimeout(Promise.resolve().then(() => generate(messages, { maxTokens: settings.maxTokens, temperature })), settings.timeoutMs)
    modelId ??= response?.modelId ?? null
    const output = parseSpanOutput(typeof response === 'string' ? response : response?.text)
    return { output, probability: typeof response?.tokenProbability === 'number' ? response.tokenProbability : null }
  }

  // Combines the samples taken so far into a decision for one candidate.
  function evaluate(candidate, samples) {
    const span = { from: candidate.from, to: candidate.to, text: candidate.text }
    const yes = samples.filter((sample) => sample.output.isAction)
    const actionMajority = yes.length * 2 > samples.length
    const primary = (actionMajority ? yes[0] : samples[0]).output
    const grounded = groundOutput(primary, span, { now: at, timeZone })
    const issues = [...grounded.issues]
    const detectorDue = dueOf(candidate.time)
    let due = detectorDue
    if (primary.timePhrase && grounded.timeHit) {
      if (detectorDue && !sameDue(detectorDue, grounded.timeHit.due)) issues.push('time-disagrees-with-detector')
      due = grounded.timeHit.due
    }
    const model = samples.reduce((sum, sample) => sum + sampleAgreement(sample.output, sample.probability), 0) / samples.length
    const confidence = computeConfidence({ detector: candidate.score, model, explicit: candidate.explicit, issues: issues.length })
    const person = grounded.person ?? groundPerson(candidate.person, candidate.text)
    return { primary, grounded, issues, due, person, confidence, actionMajority, unanimous: yes.length === samples.length }
  }

  // The model and the detector disagree when a strong candidate is rejected or a weak one accepted.
  const borderline = (candidate, result) => ((candidate.explicit || candidate.score >= 0.5) && !result.primary.isAction)
    || (candidate.score < 0.35 && result.primary.isAction)
    || (result.confidence >= BORDERLINE_LOW && result.confidence < BORDERLINE_HIGH)

  function degrade(candidate, error) {
    const reason = error.reason ?? 'model-error'
    stats.degraded.push({ from: candidate.from, to: candidate.to, reason, message: error.message })
    if (!candidate.explicit) return drop(candidate, reason, error.message)
    items.push(makeItem(candidate, source, {
      text: cleanText(candidate.text) || candidate.text.trim(), kind: deriveKind({ actor: 'me', kindHint: candidate.kindHint, signals: candidate.signals }) ?? 'task',
      person: groundPerson(candidate.person, candidate.text), due: dueOf(candidate.time), confidence: Math.min(SUGGEST_THRESHOLD, candidate.score * 0.5), auto: false, issues: [`model-failed:${reason}`],
    }, { modelId, extraSignals: [`model-failed:${reason}`] }))
  }

  t = now()
  for (const candidate of candidates) {
    const language = detectLanguage(candidate.text)
    const messages = buildSpanMessages({
      span: candidate.text, language, examples: examples.filter((example) => !example.language || example.language === language),
      context: { before: sentenceBefore(source, candidate.from), after: sentenceAfter(source, candidate.to) },
    })
    const samples = []
    let rescued = false
    try {
      stats.modelCalls += 1
      samples.push(await call(messages, 0))
    } catch (error) {
      // Temperature 0 can still emit a garbled token; one warmer retry (from the extra-call budget) is worth it.
      if (!(error instanceof ActionOutputError) || extraBudget <= 0) { degrade(candidate, error); continue }
      extraBudget -= 1
      stats.extraCalls += 1
      try { samples.push(await call(messages, settings.extraTemperature)); rescued = true } catch (retryError) { degrade(candidate, retryError); continue }
    }
    let result = evaluate(candidate, samples)
    if (borderline(candidate, result)) {
      for (let extra = 0; extra < settings.extraSamples && extraBudget > 0; extra += 1) {
        extraBudget -= 1
        stats.extraCalls += 1
        try { samples.push(await call(messages, settings.extraTemperature)) } catch { /* a failed extra sample is ignored */ }
      }
      if (samples.length > 1) result = evaluate(candidate, samples)
    }
    const extraSignals = rescued ? ['retried'] : samples.length > 1 ? [`votes:${samples.filter((sample) => sample.output.isAction).length}/${samples.length}`] : []
    const { primary, grounded, issues, due, person, confidence } = result
    const info = { quote: candidate.text, confidence }
    if (!result.actionMajority) {
      if (MARKER_SIGNALS.some((signal) => candidate.signals.includes(signal))) {
        items.push(makeItem(candidate, source, { text: cleanText(candidate.text), kind: 'task', person, due, confidence: Math.max(confidence, SUGGEST_THRESHOLD), auto: false, issues }, { modelId, extraSignals: [...extraSignals, 'model-disagrees'] }))
      } else drop(candidate, 'model-not-action', info)
      continue
    }
    const kind = deriveKind({ actor: primary.actor, kindHint: candidate.kindHint, signals: candidate.signals })
    if (!kind) { drop(candidate, 'other-persons-task', info); continue }
    const auto = candidate.explicit && primary.actor === 'me' && issues.length === 0 && result.unanimous && !rescued && confidence >= AUTO_THRESHOLD
    if (!auto && confidence < SUGGEST_THRESHOLD) { drop(candidate, 'low-confidence', info); continue }
    items.push(makeItem(candidate, source, { text: grounded.rejected || !grounded.summary ? cleanText(candidate.text) : grounded.summary, kind, person, due, confidence, auto, issues }, { modelId, extraSignals }))
  }
  stats.timing.modelMs = ms(t)
  stats.timing.totalMs = ms(started)
  stats.modelId = modelId
  stats.promptVersion = PROMPT_VERSION
  return { items, dropped, stats }
}
