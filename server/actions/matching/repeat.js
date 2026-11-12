// Repeat detection: does a freshly extracted item restate a commitment that is already open in another note?
// "Same commitment" needs a high text score, a compatible person and a compatible due date. Only open, suggested
// and snoozed actions are candidates, so a closed action (done, let go, rejected, faded) is never re-opened or
// merged into: a recurring task that was finished last month starts a new action.
import { comparePeople, compareDue, textSimilarity } from './similarity.js'

export const MATCHABLE_STATUSES = ['open', 'suggested', 'snoozed']

/**
 * Text score needed for "same commitment", by evidence available. Lexical-only thresholds are stricter because
 * stemming alone cannot see paraphrases or tell near-identical sentences about different things apart.
 * `unknownPerson` applies when exactly one side names a person (`samePerson` covers the same person and no person at all): the text has to be very similar then.
 */
export const REPEAT_THRESHOLDS = {
  lexical: { samePerson: 0.8, unknownPerson: 0.9 },
  embedding: { samePerson: 0.78, unknownPerson: 0.88 },
}

const peopleOf = (...items) => items.map((item) => item.person).filter(Boolean).flatMap((person) => String(person).split(/\s+/))

/**
 * Best open action that `item` (`{ text, person, due }`) repeats, as `{ action, score, reasons }`, or null.
 * `embeddings` is an optional Map of text -> vector covering the item and the actions.
 */
export function findRepeat(item, openActions, { embeddings = null, statuses = MATCHABLE_STATUSES } = {}) {
  let best = null
  for (const action of openActions ?? []) {
    if (!statuses.includes(action.status)) continue
    const people = comparePeople(item.person, action.person)
    if (people === 'different') continue
    const due = compareDue(item.due, action.due)
    if (due === 'conflict') continue
    const similarity = textSimilarity(item.text, action.text, { embeddings, exclude: peopleOf(item, action) })
    const table = REPEAT_THRESHOLDS[similarity.mode]
    const needed = people === 'unknown' ? table.unknownPerson : table.samePerson
    // A single shared content word is only a match when the same person ties the two sentences together.
    if (similarity.score < needed || (similarity.shared < 2 && people !== 'same')) continue
    if (!best || similarity.score > best.score) {
      best = {
        action, score: similarity.score,
        reasons: [`text ${similarity.score.toFixed(2)} (${similarity.mode})`, `person ${people}`, `due ${due}`],
      }
    }
  }
  return best
}
