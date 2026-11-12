import { dueRange } from './validate.js'

const DAY = 24 * 60 * 60 * 1000

// Quietly fades stale, non-explicit open actions. Pure over the store: no timer; #20 decides when to call it.
// An action fades when nothing touched it for `days` and it has no due date, or its due date passed more than `days` ago.
export function fadeStale(store, { now, days = 14 } = {}) {
  const at = typeof now === 'function' ? now() : now ? new Date(now) : new Date()
  const cutoff = at.getTime() - days * DAY
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10)
  const ids = store.list({ status: 'open' })
    .filter((action) => {
      if (action.explicit) return false
      if (Date.parse(action.touchedAt || action.createdAt) > cutoff) return false
      const range = dueRange(action.due)
      return !range || range.end < cutoffDay
    })
    .map((action) => action.id)
  store.markFaded(ids, at)
  return ids
}
