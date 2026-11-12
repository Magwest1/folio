// Turns "tomorrow after lunch", "neste uke" or "in 2 hours" into the instant a snooze should end.
// The date parser reads the day; this adds the few snooze-only words (lunch) and the default hour.
import { parseTimeExpressions } from '../knowledge/date-expressions.js'
import { addDays, localParts, validTimeZone, zonedInstant } from './time.js'

export const DEFAULT_HOUR = '09:00'
export const LUNCH_HOUR = '13:00'
const LUNCH = /(?<![\p{L}\p{N}])(?:after\s+lunch|etter\s+lunsj|etter\s+lunch|ved\s+lunsj|lunsj|lunch)(?![\p{L}\p{N}])/giu
const HINT = 'Try something like "tomorrow morning", "after lunch" or "neste uke".'

const fail = (message) => Object.assign(new Error(message), { status: 400 })
const clean = (text) => text.replace(/\s+/g, ' ').trim()

export function resolveSnoozePhrase(phrase, { now = new Date(), timeZone = 'UTC' } = {}) {
  if (typeof phrase !== 'string' || !clean(phrase)) throw fail(`Say when, in a few words. ${HINT}`)
  if (!validTimeZone(timeZone)) throw fail('That time zone is not one I know.')
  const text = clean(phrase).slice(0, 120)
  const lunch = LUNCH.test(text)
  LUNCH.lastIndex = 0
  const rest = clean(text.replace(LUNCH, ' '))
  const hit = rest ? parseTimeExpressions(rest, { now, timeZone }).find((item) => item.date || item.window || item.time) : null
  if (!hit && !lunch) throw fail(`I couldn't read "${text}" as a time. ${HINT}`)

  const local = localParts(now, timeZone)
  let at
  if (hit?.window) {
    // A week or a month: its first day, or tomorrow when that day has already begun.
    const date = hit.window.start > local.date ? hit.window.start : addDays(local.date, 1)
    at = zonedInstant(date > hit.window.end ? hit.window.end : date, lunch ? LUNCH_HOUR : DEFAULT_HOUR, timeZone)
  } else if (hit?.date) {
    at = zonedInstant(hit.date, hit.time || (lunch ? LUNCH_HOUR : DEFAULT_HOUR), timeZone)
    // "today" with its default hour already behind us still means later today.
    if (at <= now && hit.date === local.date && !hit.time) at = new Date(Math.ceil((now.getTime() + 2 * 3_600_000) / 900_000) * 900_000)
  } else {
    // Only a time of day ("kl 14", "after lunch"): today if still ahead, else tomorrow.
    const time = hit?.time || LUNCH_HOUR
    at = zonedInstant(local.date, time, timeZone)
    if (at <= now) at = zonedInstant(addDays(local.date, 1), time, timeZone)
  }
  if (at.getTime() <= now.getTime()) throw fail(`That time has already passed. ${HINT}`)
  return at
}
