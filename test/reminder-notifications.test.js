import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActionStore } from '../server/actions/store.js'
import { createReminderNotifier } from '../electron/reminder-notifications.js'

function fakeNotification({ supported = true, throwOnShow = false } = {}) {
  const shown = []
  class FakeNotification extends EventEmitter {
    static isSupported() { return supported }
    constructor(options) { super(); this.options = options; shown.push(this) }
    show() { if (throwOnShow) throw new Error('denied'); this.shown = true }
  }
  return { FakeNotification, shown }
}

function setup(options = {}, platform = 'darwin') {
  const { FakeNotification, shown } = fakeNotification(options)
  const focused = []
  const acked = []
  const store = createActionStore({ filePath: path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), 'folio-notify-')), 'actions.json'), now: () => new Date('2026-11-12T10:00:00Z') })
  store.flush = () => Promise.resolve()
  const runtime = { actionStore: store, reminders: { ack: (id) => acked.push(id) } }
  const notifier = createReminderNotifier({
    Notification: FakeNotification, platform, focusAction: (id) => focused.push(id), timeZone: 'Europe/Oslo', now: () => new Date('2026-11-12T10:00:00Z'),
  })
  const action = store.addManual({ text: 'Send the budget', due: { date: '2026-11-12' } })
  const reminder = { id: 'rem_1', kind: 'action', title: 'Send the budget', body: 'Due today', actionIds: [action.id], keys: ['k'], level: 'gentle' }
  return { notifier, shown, focused, acked, store, runtime, action, reminder }
}

test('a reminder becomes a silent native notification with Done, Snooze and Not important on macOS', () => {
  const { notifier, shown, runtime, reminder } = setup()
  assert.equal(notifier.handle(reminder, runtime), true)
  assert.equal(shown.length, 1)
  assert.equal(shown[0].shown, true)
  assert.equal(shown[0].options.title, 'Send the budget')
  assert.equal(shown[0].options.silent, true, 'gentle is silent')
  assert.deepEqual(shown[0].options.actions.map((button) => button.text), ['Done', 'Snooze', 'Not important'])
  const normal = setup()
  normal.notifier.handle({ ...normal.reminder, level: 'normal' }, normal.runtime)
  assert.equal(normal.shown[0].options.silent, false)
})

test('buttons route to the store: Not important is one click and permanent, Snooze goes to tomorrow morning, Done completes', async () => {
  for (const [index, expected] of [[0, 'done'], [1, 'snoozed'], [2, 'let-go']]) {
    const { notifier, shown, runtime, reminder, store, action } = setup()
    notifier.handle(reminder, runtime)
    shown[0].emit('action', {}, index)
    await new Promise((resolve) => setImmediate(resolve))
    const after = store.get(action.id)
    assert.equal(after.status, expected)
    if (expected === 'snoozed') assert.equal(after.snoozedUntil, '2026-11-13T08:00:00.000Z')
  }
  const { notifier, shown, runtime, reminder, store, action } = setup()
  notifier.handle(reminder, runtime)
  shown[0].emit('action', {}, 2)
  assert.equal(store.get(action.id).status, 'let-go', 'in-process, no round trip')
  assert.equal(store.isSuppressed({ text: 'Send the budget' }), true, 'and it can never come back as a suggestion')
})

test('clicking focuses the card; showing acks so the in-app copy is not repeated', () => {
  const { notifier, shown, runtime, reminder, focused, acked, action } = setup()
  notifier.handle(reminder, runtime)
  shown[0].emit('show')
  assert.deepEqual(acked, ['rem_1'])
  shown[0].emit('click')
  assert.deepEqual(focused, [action.id])
})

test('merged reminders have no buttons and open Home without focusing a card', () => {
  const { notifier, shown, runtime, reminder, focused } = setup()
  notifier.handle({ ...reminder, kind: 'group', title: '3 things for this morning', actionIds: ['a', 'b', 'c'] }, runtime)
  assert.equal(shown[0].options.actions, undefined)
  shown[0].emit('click')
  assert.deepEqual(focused, [null])
  shown[0].emit('action', {}, 2)
})

test('other platforms get a plain notification', () => {
  const { notifier, shown, runtime, reminder } = setup({}, 'linux')
  notifier.handle(reminder, runtime)
  assert.equal(shown[0].options.actions, undefined)
})

test('unsupported or failing notifications fail quietly and hand over to the in-app path', () => {
  const unsupported = setup({ supported: false })
  assert.equal(unsupported.notifier.delivers(), false)
  assert.equal(unsupported.notifier.handle(unsupported.reminder, unsupported.runtime), false)
  assert.equal(unsupported.shown.length, 0)

  const denied = setup()
  denied.notifier.handle(denied.reminder, denied.runtime)
  assert.equal(denied.notifier.delivers(), true)
  denied.shown[0].emit('failed', {}, 'permission denied')
  assert.equal(denied.notifier.delivers(), false, 'the renderer starts showing reminders itself')
  assert.equal(denied.notifier.handle(denied.reminder, denied.runtime), false)

  const throwing = setup({ throwOnShow: true })
  assert.doesNotThrow(() => throwing.notifier.handle(throwing.reminder, throwing.runtime))
  assert.equal(throwing.notifier.delivers(), false)
  assert.deepEqual(throwing.acked, [])
  const off = setup()
  assert.equal(off.notifier.handle({ ...off.reminder, level: 'off' }, off.runtime), false)
})
