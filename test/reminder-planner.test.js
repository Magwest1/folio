import assert from 'node:assert/strict'
import test from 'node:test'
import { planReminders } from '../server/reminders/planner.js'
import { DEFAULT_SETTINGS, mergeSettings } from '../server/reminders/settings.js'

const ZONE = 'Europe/Oslo' // UTC+1 in November, so 09:00 local is 08:00Z
let counter = 0
const act = (overrides = {}) => {
  counter += 1
  return {
    id: `a${counter}`, text: `Thing ${counter}`, kind: 'task', person: null, due: null, status: 'open', snoozedUntil: null,
    explicit: false, anchor: null, createdAt: '2026-11-01T08:00:00Z', touchedAt: '2026-11-01T08:00:00Z', history: [], ...overrides,
  }
}
const plan = (actions, at, extra = {}) => planReminders({
  actions, settings: extra.settings || structuredClone(DEFAULT_SETTINGS), now: new Date(at), timeZone: ZONE,
  ledger: extra.ledger || {}, suppressions: extra.suppressions,
})
const withSettings = (patch) => mergeSettings(DEFAULT_SETTINGS, patch)

test('undated actions never notify, however long they sit', () => {
  const idle = [act(), act({ kind: 'follow-up' }), act({ due: { window: { start: '2026-11-10', end: '2026-11-20' } } })]
  for (const at of ['2026-11-12T08:00:00Z', '2026-11-20T08:00:00Z', '2027-02-01T08:00:00Z']) {
    assert.deepEqual(plan(idle, at, { settings: withSettings({ level: 'normal' }) }).due, [])
  }
})

test('a dated action fires at the morning slot of its day, once, and nextWakeAt points at the slot', () => {
  const item = act({ due: { date: '2026-11-12' } })
  const early = plan([item], '2026-11-12T07:00:00Z')
  assert.deepEqual(early.due, [])
  assert.equal(early.nextWakeAt.toISOString(), '2026-11-12T08:00:00.000Z')
  const fired = plan([item], '2026-11-12T08:05:00Z')
  assert.equal(fired.due.length, 1)
  assert.equal(fired.due[0].title, item.text)
  assert.equal(fired.due[0].silent, true, 'gentle reminders are silent')
  const ledger = Object.fromEntries(fired.due[0].keys.map((key) => [key, '2026-11-12T08:05:00Z']))
  assert.deepEqual(plan([item], '2026-11-12T12:00:00Z', { ledger }).due, [], 'fires once per due instance')
  const moved = act({ ...item, due: { date: '2026-11-13' } })
  assert.deepEqual(plan([{ ...moved, id: item.id }], '2026-11-12T12:00:00Z', { ledger }).due, [])
  assert.equal(plan([{ ...moved, id: item.id }], '2026-11-13T09:00:00Z', { ledger }).due.length, 1, 'a new due date is a new instance')
})

test('items that are late, newly written or already handled do not fire', () => {
  assert.deepEqual(plan([act({ due: { date: '2026-11-10' } })], '2026-11-12T10:00:00Z').due, [], 'yesterday is over')
  const fresh = act({ due: { date: '2026-11-12' }, createdAt: '2026-11-12T09:00:00Z', touchedAt: '2026-11-12T09:00:00Z' })
  assert.deepEqual(plan([fresh], '2026-11-12T09:30:00Z').due, [], 'written after the slot, so nothing to remind')
  for (const status of ['done', 'let-go', 'rejected', 'faded', 'suggested']) {
    assert.deepEqual(plan([act({ due: { date: '2026-11-12' }, status })], '2026-11-12T09:00:00Z').due, [], status)
  }
})

test('gentle folds timed items into the morning slot; normal sends them at their time, one by one', () => {
  const lunch = act({ due: { date: '2026-11-12', time: '12:30' }, kind: 'event' })
  const gentle = plan([lunch], '2026-11-12T08:10:00Z')
  assert.equal(gentle.due.length, 1)
  assert.equal(gentle.due[0].at, '2026-11-12T08:00:00.000Z')
  const normal = withSettings({ level: 'normal' })
  const before = plan([lunch], '2026-11-12T08:10:00Z', { settings: normal })
  assert.deepEqual(before.due, [])
  assert.equal(before.nextWakeAt.toISOString(), '2026-11-12T11:30:00.000Z')
  const at = plan([lunch], '2026-11-12T11:31:00Z', { settings: normal })
  assert.equal(at.due.length, 1)
  assert.equal(at.due[0].silent, false)
  assert.match(at.due[0].body, /12:30/)
  const second = act({ due: { date: '2026-11-12', time: '12:30' } })
  assert.equal(plan([lunch, second], '2026-11-12T11:31:00Z', { settings: normal }).due.length, 2, 'timed reminders are never merged')
  assert.equal(plan([lunch], '2026-11-12T14:00:00Z', { settings: normal }).due.length, 0, 'a meeting that started over two hours ago is not announced')
})

test('gentle merges several items due in one slot into a single notification', () => {
  const items = [1, 2, 3].map(() => act({ due: { date: '2026-11-12' } }))
  const result = plan(items, '2026-11-12T08:30:00Z')
  assert.equal(result.due.length, 1)
  assert.equal(result.due[0].kind, 'group')
  assert.equal(result.due[0].title, '3 things for this morning')
  assert.deepEqual(result.due[0].actionIds, items.map((item) => item.id))
  const four = [...items, act({ due: { date: '2026-11-12' } })]
  assert.match(plan(four, '2026-11-12T08:30:00Z').due[0].body, /and 1 more$/)
})

test('level off sends nothing, but still reports quiet items for the Home prompt', () => {
  const off = withSettings({ level: 'off' })
  assert.deepEqual(plan([act({ due: { date: '2026-11-12' } }), act({ status: 'snoozed', snoozedUntil: '2026-11-12T07:00:00Z' })], '2026-11-12T09:00:00Z', { settings: off }).due, [])
  const quiet = act({ touchedAt: '2026-10-20T08:00:00Z' })
  assert.equal(plan([quiet], '2026-11-12T09:00:00Z', { settings: off }).checkins.length, 1)
})

test('a snooze fires when it ends, even for undated or waiting-on items, and each snooze is its own instance', () => {
  const sleepy = act({ status: 'snoozed', snoozedUntil: '2026-11-13T08:00:00Z' })
  const waiting = act({ kind: 'waiting-on', status: 'snoozed', snoozedUntil: '2026-11-13T08:00:00Z' })
  const wait = plan([sleepy, waiting], '2026-11-12T12:00:00Z')
  assert.deepEqual(wait.due, [])
  assert.equal(wait.nextWakeAt.toISOString(), '2026-11-13T08:00:00.000Z')
  const woke = plan([sleepy], '2026-11-13T08:01:00Z')
  assert.equal(woke.due.length, 1)
  assert.match(woke.due[0].body, /Back from snooze/)
  const ledger = Object.fromEntries(woke.due[0].keys.map((key) => [key, '2026-11-13T08:01:00Z']))
  assert.deepEqual(plan([sleepy], '2026-11-13T09:00:00Z', { ledger }).due, [])
  const again = { ...sleepy, snoozedUntil: '2026-11-14T08:00:00Z' }
  assert.equal(plan([again], '2026-11-14T08:01:00Z', { ledger }).due.length, 1, 'snoozing again earns one more reminder')
  assert.equal(plan([waiting], '2026-11-13T08:01:00Z').due.length, 1)
})

test('quiet hours defer to the end of the window, across midnight, and an off switch is respected', () => {
  const late = act({ status: 'snoozed', snoozedUntil: '2026-11-12T22:30:00Z' }) // 23:30 in Oslo
  const night = plan([late], '2026-11-12T22:45:00Z')
  assert.deepEqual(night.due, [])
  assert.equal(night.nextWakeAt.toISOString(), '2026-11-13T07:00:00.000Z', '08:00 local the next morning')
  assert.equal(plan([late], '2026-11-13T07:01:00Z').due.length, 1)
  const early = act({ status: 'snoozed', snoozedUntil: '2026-11-13T04:00:00Z' }) // 05:00 local, same night
  assert.equal(plan([early], '2026-11-13T05:00:00Z').nextWakeAt.toISOString(), '2026-11-13T07:00:00.000Z')
  const open = withSettings({ quietHours: { enabled: false } })
  assert.equal(plan([late], '2026-11-12T22:45:00Z', { settings: open }).due.length, 1)
  const daytime = withSettings({ quietHours: { start: '12:00', end: '14:00' } })
  const noon = act({ status: 'snoozed', snoozedUntil: '2026-11-12T11:30:00Z' })
  assert.equal(plan([noon], '2026-11-12T11:45:00Z', { settings: daytime }).nextWakeAt.toISOString(), '2026-11-12T13:00:00.000Z')
})

test('muted kinds, excluded sources and waiting-on without a follow-up date stay silent', () => {
  const due = { date: '2026-11-12' }
  const mutedKind = act({ kind: 'follow-up', due })
  const excluded = act({ due, anchor: { noteId: '/projects/alpha/plan.md' } })
  const folder = act({ due, anchor: { noteId: '/archive/old.md' } })
  const kept = act({ due })
  const suppressions = { kinds: ['follow-up'], sources: ['/projects/alpha/plan.md', '/archive/'] }
  const result = plan([mutedKind, excluded, folder, kept], '2026-11-12T09:00:00Z', { suppressions })
  assert.deepEqual(result.due.flatMap((reminder) => reminder.actionIds), [kept.id])
  assert.deepEqual(plan([act({ kind: 'waiting-on' })], '2026-11-12T09:00:00Z').due, [])
  assert.equal(plan([act({ kind: 'waiting-on', due })], '2026-11-12T09:00:00Z').due.length, 1)
  assert.deepEqual(plan([act({ status: 'snoozed', snoozedUntil: '2026-11-12T07:00:00Z', kind: 'follow-up' })], '2026-11-12T09:00:00Z', { suppressions }).due, [])
})

test('check-in: asked once for a quiet, non-explicit item, never for explicit or recent ones', () => {
  const quiet = act({ touchedAt: '2026-10-20T08:00:00Z' })
  const explicit = act({ touchedAt: '2026-10-01T08:00:00Z', explicit: true })
  const recent = act({ touchedAt: '2026-11-05T08:00:00Z' })
  const upcoming = act({ touchedAt: '2026-10-01T08:00:00Z', due: { date: '2026-11-20' } })
  const first = plan([quiet, explicit, recent, upcoming], '2026-11-12T09:00:00Z')
  assert.deepEqual(first.checkins.map((item) => item.actionId), [quiet.id])
  assert.equal(first.checkins[0].fresh, true)
  assert.deepEqual(first.due, [], 'a check-in is never a notification at gentle level')
  const ledger = { [first.checkins[0].key]: '2026-11-12T09:00:00.000Z' }
  const later = plan([quiet], '2026-11-14T09:00:00Z', { ledger })
  assert.equal(later.checkins[0].fresh, false, 'the same stretch is never asked about twice')
  assert.equal(later.checkins[0].since, '2026-11-12T09:00:00.000Z')
  assert.deepEqual(later.fade, [])
  assert.equal(later.nextWakeAt.toISOString(), '2026-11-19T09:00:00.000Z')
  const kept = { ...quiet, touchedAt: '2026-11-13T09:00:00Z' }
  assert.deepEqual(plan([kept], '2026-11-14T09:00:00Z', { ledger }).checkins, [], 'Keep resets the clock')
})

test('check-in: no answer within the fade window fades the item silently', () => {
  const quiet = act({ touchedAt: '2026-10-20T08:00:00Z' })
  const ledger = { [`checkin:${quiet.id}:${quiet.touchedAt}`]: '2026-11-12T09:00:00.000Z' }
  assert.deepEqual(plan([quiet], '2026-11-19T08:59:00Z', { ledger }).fade, [])
  const result = plan([quiet], '2026-11-19T09:00:00Z', { ledger })
  assert.deepEqual(result.fade, [quiet.id])
  assert.deepEqual(result.due, [])
  const custom = withSettings({ stillRelevantAfterDays: 30, fadeAfterDays: 3 })
  assert.deepEqual(plan([quiet], '2026-11-12T09:00:00Z', { settings: custom }).checkins, [])
})

test('the morning brief summarises today once, in calm words, and folds the day\'s items into itself', () => {
  const settings = withSettings({ morningBrief: { enabled: true, time: '08:30' }, level: 'normal' })
  const items = [act({ due: { date: '2026-11-12' } }), act({ due: { date: '2026-11-12' } }), act({ kind: 'waiting-on', due: { date: '2026-11-12' } }),
    act({ touchedAt: '2026-10-20T08:00:00Z' })]
  const before = plan(items, '2026-11-12T07:00:00Z', { settings })
  assert.deepEqual(before.due, [])
  assert.equal(before.nextWakeAt.toISOString(), '2026-11-12T07:30:00.000Z')
  const result = plan(items, '2026-11-12T07:31:00Z', { settings })
  assert.equal(result.due.length, 1, 'one notification, not one per item')
  const [brief] = result.due
  assert.equal(brief.kind, 'brief')
  assert.equal(brief.title, 'Good morning. Thursday looks fairly light.')
  assert.equal(brief.body, '2 things today · 1 waiting on others · 1 to check in on')
  assert.ok(brief.keys.includes('brief:2026-11-12'))
  assert.ok(brief.keys.length >= 3, 'the folded items are stamped too')
  const ledger = Object.fromEntries(brief.keys.map((key) => [key, '2026-11-12T07:31:00Z']))
  const after = plan(items, '2026-11-12T09:00:00Z', { settings, ledger })
  assert.deepEqual(after.due, [])
  assert.equal(after.nextWakeAt.toISOString(), '2026-11-13T07:30:00.000Z')
})

test('the brief stays quiet on an empty day, and gentle never puts check-ins in it', () => {
  const settings = withSettings({ morningBrief: { enabled: true, time: '08:30' } })
  const empty = plan([act()], '2026-11-12T07:31:00Z', { settings })
  assert.deepEqual(empty.due, [])
  assert.deepEqual(empty.silentKeys, ['brief:2026-11-12'])
  const gentle = plan([act({ touchedAt: '2026-10-20T08:00:00Z' })], '2026-11-12T07:31:00Z', { settings })
  assert.deepEqual(gentle.due, [], 'check-ins ride along only at the normal level')
  const late = plan([act({ due: { date: '2026-11-12' } })], '2026-11-12T16:00:00Z', { settings })
  assert.deepEqual(late.due, [], 'a morning brief is not sent in the evening')
})

test('a brief that falls in quiet hours waits for the window to end', () => {
  const settings = withSettings({ morningBrief: { enabled: true, time: '07:30' } })
  const item = act({ due: { date: '2026-11-12' } })
  assert.deepEqual(plan([item], '2026-11-12T06:45:00Z', { settings }).due, [])
  assert.equal(plan([item], '2026-11-12T06:45:00Z', { settings }).nextWakeAt.toISOString(), '2026-11-12T07:00:00.000Z')
  assert.equal(plan([item], '2026-11-12T07:01:00Z', { settings }).due[0].kind, 'brief')
})
