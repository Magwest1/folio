// Store methods for the matching phase (issue #21): merging a repeated commitment into an open action, finishing an
// action from evidence in a later note, and suggesting that finish. Every automatic change is a history entry with
// `by: 'system'` and a `reason`, so the regular undo can take it back; undoing one also remembers the evidence so it
// is never applied or suggested again. Additive schema on each action:
//   anchors: []                secondary anchors (other notes that repeat the commitment); `anchor` stays the primary one
//   sourceAt                   reference time of the note the action was extracted from
//   completion                 { noteId, quote, score, at, auto } evidence behind a done status that came from a note
//   completionSuggestion       { noteId, quote, from, to, score, at } waiting for the user to answer "Looks done?"
//   completionDismissed: []    quote keys of evidence that was dismissed, accepted and undone, or undone
//   mergeBlocked: []           quote keys of passages whose merge the user undid
import { dueRange, httpError, CLOSED_STATUSES } from './validate.js'
import { quoteKey } from './fingerprint.js'

export const MATCHING_VERSION = 1
const OPEN_FOR_MATCHING = ['open', 'suggested', 'snoozed']

/** Whether `next` is a later or more specific due than `current` (a date inside a window, or a time on a date). */
export function refinesDue(current, next) {
  const a = dueRange(current)
  const b = dueRange(next)
  if (!b) return false
  if (!a) return true
  if (b.start >= a.start && b.end <= a.end && (b.start !== a.start || b.end !== a.end)) return true
  if (b.end > a.end) return true
  return a.start === b.start && a.end === b.end && Boolean(next.time) && !current.time
}

const evidenceOf = (evidence, at) => ({
  noteId: evidence.noteId ?? null, quote: String(evidence.quote ?? '').slice(0, 500),
  from: Number.isInteger(evidence.from) ? evidence.from : null, to: Number.isInteger(evidence.to) ? evidence.to : null,
  score: typeof evidence.score === 'number' ? Math.round(evidence.score * 1000) / 1000 : null, at: evidence.at ?? at,
})

export function createMatchingMethods({ data, require, move, stamp, persist, present, transition }) {
  const blocked = (action, key) => Boolean(key) && (action.completionDismissed ?? []).includes(key)
  const block = (action, key) => {
    if (!key || blocked(action, key)) return
    ;(action.completionDismissed ??= []).push(key)
  }
  const system = (action, to, entry) => {
    if (to !== action.status) move(action, to, { by: 'system' })
    else {
      action.history.push({ at: stamp(), from: action.status, to, by: 'system', ...(action.status === 'snoozed' ? { snoozedUntil: action.snoozedUntil } : {}) })
      action.updatedAt = action.history.at(-1).at
    }
    Object.assign(action.history.at(-1), entry)
  }

  return {
    // Open, suggested and snoozed actions that matching may compare against. Todo-list lines are managed in that file.
    openForMatching: () => data().actions.filter((action) => OPEN_FOR_MATCHING.includes(action.status) && action.origin !== 'todo-list').map((action) => present(action)),

    // A later note restates a commitment that is already open. Adds a secondary anchor and refreshes the due date,
    // never touching user edits. Returns the action, or null when nothing was merged (closed, same note, or undone before).
    mergeRepeat(actionId, item, { noteId, noteVersion = null } = {}) {
      const action = require(actionId)
      const quote = String(item?.anchor?.quote ?? '')
      const key = quoteKey(quote)
      if (!noteId || !item?.anchor || CLOSED_STATUSES.includes(action.status) || action.anchor?.noteId === noteId) return null
      if (action.mergeBlocked?.includes(key)) return null
      const anchors = (action.anchors ??= [])
      const known = anchors.find((anchor) => anchor.noteId === noteId && quoteKey(anchor.quote) === key)
      const fresh = { noteId, version: noteVersion, from: item.anchor.from, to: item.anchor.to, quote, orphaned: false }
      if (known) {
        const moved = known.from !== fresh.from || known.to !== fresh.to || known.orphaned
        Object.assign(known, fresh)
        if (moved) persist()
        return present(action)
      }
      const previousDue = action.due ?? null
      const refresh = !action.editedByUser && refinesDue(previousDue, item.due)
      anchors.push({ ...fresh, addedAt: stamp() })
      if (refresh) action.due = item.due
      action.touchedAt = stamp()
      system(action, action.status, { reason: 'repeat', noteId, quoteKey: key, ...(refresh ? { previousDue } : {}) })
      persist()
      return present(action)
    },

    // A clear completion in a later note: done, by the system, with the evidence kept and the regular undo available.
    completeFromEvidence(actionId, evidence = {}) {
      const action = require(actionId)
      const key = quoteKey(evidence.quote)
      if (CLOSED_STATUSES.includes(action.status) || blocked(action, key)) return null
      const at = stamp()
      action.completion = { ...evidenceOf(evidence, at), auto: true }
      action.completionSuggestion = null
      system(action, 'done', { reason: 'completion', noteId: action.completion.noteId, quoteKey: key })
      persist()
      return present(action)
    },

    // A probable completion that waits for the user. The status does not change.
    suggestCompletion(actionId, evidence = {}) {
      const action = require(actionId)
      const key = quoteKey(evidence.quote)
      if (CLOSED_STATUSES.includes(action.status) || blocked(action, key) || !key) return null
      const current = action.completionSuggestion
      const next = evidenceOf(evidence, stamp())
      if (current && (quoteKey(current.quote) === key || (current.score ?? 0) >= (next.score ?? 0))) return present(action)
      action.completionSuggestion = next
      action.updatedAt = stamp()
      persist()
      return present(action)
    },

    acceptCompletion(actionId) {
      const action = require(actionId)
      const suggestion = action.completionSuggestion
      if (!suggestion) throw httpError(409, 'There is no completion suggestion to accept.')
      block(action, quoteKey(suggestion.quote))
      action.completion = { ...suggestion, auto: false }
      action.completionSuggestion = null
      return transition(actionId, 'done', 'completed')
    },

    dismissCompletion(actionId) {
      const action = require(actionId)
      const suggestion = action.completionSuggestion
      if (suggestion) {
        block(action, quoteKey(suggestion.quote))
        action.completionSuggestion = null
        action.updatedAt = stamp()
        persist()
      }
      return present(action)
    },

    // Called when the user brings back a done action: the evidence behind it must not close it again.
    forgetCompletion(action) {
      if (action.completion) { block(action, quoteKey(action.completion.quote)); action.completion = null }
    },

    // Takes back the last history entry when it was a system change. Returns the view, or null for a user step.
    undoSystem(actionId) {
      const action = require(actionId)
      const last = action.history.at(-1)
      if (last?.by !== 'system' || !last.reason) return null
      action.history.pop()
      if (last.reason === 'repeat') {
        const index = (action.anchors ?? []).findLastIndex((anchor) => anchor.noteId === last.noteId && quoteKey(anchor.quote) === last.quoteKey)
        if (index !== -1) action.anchors.splice(index, 1)
        if ('previousDue' in last) action.due = last.previousDue
        ;(action.mergeBlocked ??= []).push(last.quoteKey)
      } else if (last.reason === 'completion') {
        action.status = last.from
        action.snoozedUntil = last.snoozedUntil ?? null
        block(action, last.quoteKey)
        action.completion = null
      }
      action.updatedAt = stamp()
      action.touchedAt = action.updatedAt
      persist()
      return present(action)
    },
  }
}
