// Completion detection: does a sentence that reports finished work ("sent the budget to Anna", "ringte Kari") finish
// an action that is still open? Verb tense is bridged by the past-to-base tables in verbs.js. Only very clear
// matches are applied on their own (`auto`); everything else is a suggestion the user answers, and a middle band
// is returned as `ambiguous` for the caller to confirm with a single yes/no model question or drop.
import * as lexicon from '../lexicon.js'
import { MATCHABLE_STATUSES } from './repeat.js'
import { comparePeople, mentionsPerson, textSimilarity } from './similarity.js'
import { DONE_WORDS, NOT_YET, PARTIAL_PROGRESS, PAST_TO_BASE } from './verbs.js'

/**
 * Score thresholds on the completion score: 0.15 * Jaccard + 0.85 * the share of the action's content words that the
 * sentence repeats (so extra words like "all sorted" cost little, a missing object costs a lot), raised by embedding
 * similarity when vectors are available (never lowered by it).
 * - `suggest`: at least this on the lexical score alone and the user sees "Looks done?". Embeddings cannot lift a pair
 *   into a suggestion, because they cannot tell "chairs" from "desks": that is what the model question is for.
 * - `ask`: from here up to `suggest` the match is `ambiguous`: ask the model one yes/no question or drop it. Embeddings
 *   can lift a pair into this band.
 * - `auto`: at least this, with the same person (or none on either side) and a clear margin, and it is applied.
 *   Full coverage of the action's words is practically required: three of four words scores 0.79 at best.
 * - `margin`: the best score must beat the runner-up by this much to be auto-applied.
 * - `tie`: below this margin over the runner-up the sentence could mean either action, so nothing is reported at all.
 * Chosen on test/fixtures/action-eval/matching-cases.json for auto precision of at least 0.97 (see the README there).
 */
export const COMPLETION_THRESHOLDS = { suggest: 0.7, ask: 0.45, auto: 0.85, margin: 0.2, tie: 0.05 }

const SENTENCE_START = '(?:^|[.!?;:,]\\s*|\\s)'
const AUXILIARIES = '(?:(?:has|have|had|already|just|also|finally|har|hadde|allerede|nettopp|også)\\s+)*'
const PAST_FORMS = Object.keys(PAST_TO_BASE).filter((form) => /^[\p{L}-]+$/u.test(form)).join('|')
const NAMED_SUBJECT = new RegExp(`${SENTENCE_START}(\\p{Lu}[\\p{L}'’-]+)\\s+${AUXILIARIES}(?:${PAST_FORMS})(?![\\p{L}\\p{N}])`, 'u')
const PRONOUN_SUBJECT = new RegExp(`${SENTENCE_START}(he|she|they|han|hun|de)\\s+${AUXILIARIES}(?:${PAST_FORMS})(?![\\p{L}\\p{N}])`, 'iu')
const WRITER_SUBJECT = new RegExp(`(?<![\\p{L}\\p{N}])(?:i|we|jeg|vi)(?:['’](?:ve|d))?\\s+${AUXILIARIES}(?:${PAST_FORMS})(?![\\p{L}\\p{N}])`, 'iu')
const REPORTS_PAST = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PAST_FORMS}|${[...DONE_WORDS].join('|')})(?![\\p{L}\\p{N}])`, 'iu')
const NOT_A_NAME = new Set([...lexicon.NAME_STOP, 'we', 'jeg', 'vi', 'then', 'finally', 'done', 'ferdig', 'also', 'etterpå', 'deretter'])

/** The third party who did the work ("Anna sent hers"), or null when the writer did it (or nobody is named). */
export function otherSubject(text) {
  const plain = String(text ?? '').replace(/^[\s>*_~-]*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/, '')
  // "I finally sent it, and she confirmed": the writer did the work, whatever else happened in the sentence.
  if (WRITER_SUBJECT.test(plain)) return null
  const named = plain.match(NAMED_SUBJECT)?.[1]
  if (named && !NOT_A_NAME.has(named.toLocaleLowerCase())) return named
  return plain.match(PRONOUN_SUBJECT)?.[1] ?? null
}

/** Statements that do not report finished work: no past tense at all, negated, not yet, partial progress, hypothetical, questions. */
export function reportsNoCompletion(text, { checked = false } = {}) {
  const value = String(text ?? '')
  return (!checked && !REPORTS_PAST.test(value)) || PARTIAL_PROGRESS.test(value) || NOT_YET.test(value) || lexicon.NEGATION.test(value) || lexicon.HYPOTHETICAL.test(value)
    || /\?\s*$/.test(value.trim())
}

const peopleOf = (...items) => items.map((item) => item.person).filter(Boolean).flatMap((person) => String(person).split(/\s+/))
const instant = (value) => { const time = value instanceof Date ? value.getTime() : Date.parse(value); return Number.isNaN(time) ? null : time }

/**
 * Best open action that `candidate` (`{ text, person, checked }`, a detector completion candidate; `checked` marks a ticked checkbox, which needs no past tense) completes, as
 * `{ action, score, reasons, auto, ambiguous }`, or null. `now` is the note's reference time: a completion dated before
 * the action existed (its source note's time, else its creation) cannot finish it. `embeddings` is an optional
 * Map of text -> vector.
 */
export function findCompletion(candidate, openActions, { embeddings = null, now = new Date() } = {}) {
  const text = String(candidate?.text ?? '').trim()
  if (!text || reportsNoCompletion(text, { checked: candidate.checked === true })) return null
  const at = instant(now)
  const other = otherSubject(text)
  const scored = []
  for (const action of openActions ?? []) {
    if (!MATCHABLE_STATUSES.includes(action.status) || action.origin === 'todo-list') continue
    const since = instant(action.sourceAt ?? action.createdAt)
    if (at !== null && since !== null && at < since) continue
    // Someone else finishing something counts only for work I am waiting on from exactly that person.
    const waitingOnThem = other && ['waiting-on', 'follow-up'].includes(action.kind) && comparePeople(other, action.person) === 'same'
    if (other && !waitingOnThem) continue
    let people = waitingOnThem ? 'same' : comparePeople(candidate.person, action.person)
    // The sentence itself names the action's person even when the detector did not pick the name up.
    if ((people === 'unknown' || people === 'none') && mentionsPerson(text, action.person)) people = 'same'
    if (people === 'different') continue
    const similarity = textSimilarity(text, action.text, { embeddings, exclude: [...peopleOf(candidate, action), ...(other ? [other] : [])], role: 'completion' })
    if (similarity.shared < 2 && people !== 'same') continue
    scored.push({ action, similarity, people, waitingOnThem })
  }
  scored.sort((left, right) => right.similarity.score - left.similarity.score)
  const [best, runnerUp] = scored
  if (!best) return null
  const { score, mode, lexical } = best.similarity
  const table = COMPLETION_THRESHOLDS
  if (score < table.ask) return null
  const margin = score - (runnerUp?.similarity.score ?? 0)
  if (runnerUp && margin < table.tie) return null
  const clearPerson = best.people === 'same' || best.people === 'none'
  const ambiguous = lexical < table.suggest
  const auto = !ambiguous && score >= table.auto && clearPerson && margin >= table.margin && !best.waitingOnThem
  return {
    action: best.action, score, auto, ambiguous,
    reasons: [`text ${score.toFixed(2)} (${mode})`, `person ${best.people}`, `margin ${margin.toFixed(2)}`, ...(best.waitingOnThem ? ['done by the person waited on'] : [])],
  }
}
