// Pure reminder planning. Given the actions, the settings, the clock and the ledger of what already fired, it says
// what to tell the user now and when to look again. It never writes anything and never calls a model.
//
// Principles: only dated or triggered items notify; each due or snooze instance fires once; quiet hours defer;
// gentle merges; muted kinds and excluded sources stay silent; at most one "still relevant?" per quiet stretch.
import crypto from 'node:crypto'
import { isQuiet } from '../actions/fade.js'
import { briefTitle, briefSummary, groupTitle } from './phrases.js'
import { addDays, clockMinutes, localParts, zonedInstant } from './time.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const MORNING_SLOT = '09:00'
const TIMED_GRACE = 2 * HOUR
const DEFERRED_GRACE = 3 * HOUR
const SNOOZE_GRACE = 2 * DAY
const BRIEF_GRACE = 6 * HOUR

const inScope = (scope, id) => (scope.endsWith('/') ? id.startsWith(scope) : id === scope)
const instantOf = (value) => (value instanceof Date ? value : new Date(value))

function deferQuiet(at, quiet, timeZone) {
  if (!quiet?.enabled) return at
  const start = clockMinutes(quiet.start)
  const end = clockMinutes(quiet.end)
  if (start === end) return at
  const local = localParts(at, timeZone)
  const wraps = start > end
  const inside = wraps ? local.minutes >= start || local.minutes < end : local.minutes >= start && local.minutes < end
  if (!inside) return at
  return zonedInstant(wraps && local.minutes >= start ? addDays(local.date, 1) : local.date, quiet.end, timeZone)
}

const reminderId = (keys) => `rem_${crypto.createHash('sha1').update([...keys].sort().join('|')).digest('hex').slice(0, 12)}`

function singleReminder(candidate, level, at) {
  const { action } = candidate
  const parts = candidate.kind === 'snooze' ? ['Back from snooze'] : [action.due?.time ? `Today at ${action.due.time}` : 'Due today']
  if (action.person) parts.push(action.person)
  return {
    id: reminderId([candidate.key]), kind: 'action', title: action.text, body: parts.join(' · '),
    actionIds: [action.id], keys: [candidate.key], at: at.toISOString(), level, silent: level === 'gentle',
  }
}

function groupReminder(members, level, at, timeZone) {
  const texts = members.map((member) => member.action.text)
  const shown = texts.slice(0, 3).join(' · ')
  const keys = members.map((member) => member.key)
  return {
    id: reminderId(keys), kind: 'group', title: groupTitle(members.length, localParts(at, timeZone).minutes),
    body: texts.length > 3 ? `${shown} · and ${texts.length - 3} more` : shown,
    actionIds: members.map((member) => member.action.id), keys, at: at.toISOString(), level, silent: level === 'gentle',
  }
}

export function planReminders({ actions, settings, now, timeZone = 'UTC', ledger = {}, suppressions = { kinds: [], sources: [] } }) {
  const current = instantOf(now)
  const nowMs = current.getTime()
  const today = localParts(current, timeZone).date
  const { level, quietHours, morningBrief } = settings
  const muted = new Set(suppressions.kinds || [])
  const excluded = suppressions.sources || []
  const live = (actions || []).filter((action) => !muted.has(action.kind)
    && !(action.anchor?.noteId && excluded.some((source) => inScope(source, action.anchor.noteId))))
  const lapsed = (action) => action.status === 'snoozed' && action.snoozedUntil && Date.parse(action.snoozedUntil) <= nowMs
  const openLike = (action) => action.status === 'open' || lapsed(action)

  const wakes = []
  const briefOn = level !== 'off' && morningBrief.enabled
  const slot = briefOn ? morningBrief.time : MORNING_SLOT
  const candidates = []

  if (level !== 'off') {
    for (const action of live) {
      const add = (instance, kind, base, { grace, dayLevel = false, guarded = true }) => {
        const key = `fire:${action.id}:${instance}`
        if (ledger[key]) return
        // Created or touched after its slot: the user just saw it, so there is nothing to remind them of.
        if (guarded && Date.parse(action.touchedAt || action.createdAt) > base.getTime()) return
        const at = deferQuiet(base, quietHours, timeZone)
        const deferred = at.getTime() !== base.getTime()
        // A day-level item is only ever for its own day; afterwards it stays quietly on Home.
        const limit = dayLevel ? zonedInstant(addDays(localParts(base, timeZone).date, 1), '00:00', timeZone).getTime() : base.getTime() + grace
        candidates.push({ action, key, kind, at, base, dayLevel, staleAt: Math.max(limit, at.getTime() + (deferred ? DEFERRED_GRACE : 0)) })
      }
      if (action.status === 'snoozed' && action.snoozedUntil) {
        // A snooze is an explicit follow-up date, so it notifies whatever the kind (and even when undated).
        const until = new Date(action.snoozedUntil)
        add(`snooze:${action.snoozedUntil}`, 'snooze', until, { grace: SNOOZE_GRACE, guarded: false })
        continue
      }
      if (action.status !== 'open' || !action.due?.date) continue
      const { date, time } = action.due
      const instance = `due:${date}${time ? `T${time}` : ''}`
      const slotAt = zonedInstant(date, slot, timeZone)
      const timedAt = time ? zonedInstant(date, time, timeZone) : null
      // Gentle folds a timed item into the morning slot of its day (earlier if the item itself is earlier).
      if (timedAt && level === 'normal') add(instance, 'timed', timedAt, { grace: TIMED_GRACE })
      else add(instance, 'day', timedAt && timedAt < slotAt ? timedAt : slotAt, { grace: DAY, dayLevel: true })
    }
  }

  const eligible = []
  for (const candidate of candidates) {
    if (candidate.staleAt <= nowMs) continue
    if (candidate.at.getTime() > nowMs) { wakes.push(candidate.at.getTime()); continue }
    eligible.push(candidate)
  }

  const due = []
  const folded = []
  for (const candidate of eligible) {
    if (briefOn && candidate.dayLevel) folded.push(candidate)
    else if (candidate.kind === 'timed') due.push(singleReminder(candidate, level, candidate.at))
  }
  const grouped = new Map()
  for (const candidate of eligible) {
    if (candidate.kind === 'timed' || (briefOn && candidate.dayLevel)) continue
    const bucket = grouped.get(candidate.at.getTime()) || []
    bucket.push(candidate)
    grouped.set(candidate.at.getTime(), bucket)
  }
  for (const [atMs, members] of grouped) {
    due.push(members.length === 1 ? singleReminder(members[0], level, new Date(atMs)) : groupReminder(members, level, new Date(atMs), timeZone))
  }

  const checkins = []
  const fade = []
  const quietDays = settings.stillRelevantAfterDays
  for (const action of live) {
    if (!openLike(action)) continue
    const touched = Date.parse(action.touchedAt || action.createdAt)
    if (!isQuiet(action, { at: current, days: quietDays })) {
      if (!action.explicit && !action.due) wakes.push(touched + quietDays * DAY)
      continue
    }
    const key = `checkin:${action.id}:${action.touchedAt || action.createdAt}`
    const since = ledger[key]
    checkins.push({ actionId: action.id, key, since: since || current.toISOString(), fresh: !since })
    if (since) {
      const fadeAt = Date.parse(since) + settings.fadeAfterDays * DAY
      if (fadeAt <= nowMs) fade.push(action.id)
      else wakes.push(fadeAt)
    }
  }

  const reportable = level === 'normal' && briefOn ? checkins.length : 0
  if (briefOn) {
    const briefKey = `brief:${today}`
    const base = zonedInstant(today, morningBrief.time, timeZone)
    const at = deferQuiet(base, quietHours, timeZone)
    if (!ledger[briefKey] && at.getTime() > nowMs) wakes.push(at.getTime())
    else if (ledger[briefKey] || at.getTime() + BRIEF_GRACE <= nowMs) wakes.push(deferQuiet(zonedInstant(addDays(today, 1), morningBrief.time, timeZone), quietHours, timeZone).getTime())
    else {
      const things = live.filter((action) => openLike(action) && action.kind !== 'waiting-on' && action.due?.date === today)
      const waiting = live.filter((action) => openLike(action) && action.kind === 'waiting-on' && action.due?.date === today)
      if (things.length || waiting.length || reportable) {
        const keys = [briefKey, ...folded.map((candidate) => candidate.key)]
        due.push({
          id: reminderId(keys), kind: 'brief', title: briefTitle(today, localParts(at, timeZone).minutes, things.length),
          body: briefSummary({ things: things.length, waiting: waiting.length, checkins: reportable }),
          actionIds: [...new Set([...things, ...waiting].map((action) => action.id))], keys, at: at.toISOString(), level, silent: level === 'gentle',
        })
      } else {
        // Nothing worth saying: the day passes without a brief rather than an empty one.
        due.push({ id: reminderId([briefKey]), kind: 'none', keys: [briefKey, ...folded.map((candidate) => candidate.key)], actionIds: [] })
      }
    }
  }

  const future = wakes.filter((wake) => wake > nowMs)
  return {
    due: due.filter((reminder) => reminder.kind !== 'none'), nextWakeAt: future.length ? new Date(Math.min(...future)) : null,
    checkins, fade,
    // Keys to stamp even when no notification is sent (an empty day's brief).
    silentKeys: due.filter((reminder) => reminder.kind === 'none').flatMap((reminder) => reminder.keys),
  }
}
