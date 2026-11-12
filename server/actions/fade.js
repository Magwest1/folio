import { dueRange } from './validate.js'

const DAY = 24 * 60 * 60 * 1000

const instant = (now) => (typeof now === 'function' ? now() : now ? new Date(now) : new Date())

// An action is quiet when nothing touched it for `days` and it has no due date, or its due date passed more than
// `days` ago. Explicit (manual or todo-list) actions are never quiet. Shared by the fade pass and the reminder check-in.
export function isQuiet(action, { at, days }) {
  if (action.explicit) return false
  const cutoff = at.getTime() - days * DAY
  if (Date.parse(action.touchedAt || action.createdAt) > cutoff) return false
  const range = dueRange(action.due)
  return !range || range.end < new Date(cutoff).toISOString().slice(0, 10)
}

// Quietly fades stale, non-explicit open actions. Pure over the store: the reminder service decides when to call it.
export function fadeStale(store, { now, days = 14 } = {}) {
  const at = instant(now)
  const ids = store.list({ status: 'open' }).filter((action) => isQuiet(action, { at, days })).map((action) => action.id)
  store.markFaded(ids, at)
  return ids
}

// Fades the given actions that were asked "still relevant?" and never answered. Only still-open actions move.
export function fadeUnanswered(store, ids, { now } = {}) {
  const at = instant(now)
  const open = new Set(store.list({ status: 'open' }).map((action) => action.id))
  const fading = ids.filter((id) => open.has(id))
  store.markFaded(fading, at)
  return fading
}
