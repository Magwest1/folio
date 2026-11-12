import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActionStore } from '../server/actions/store.js'
import { createReminderService } from '../server/reminders/service.js'

const MINUTE = 60_000
const START = Date.parse('2026-11-12T07:00:00Z') // 08:00 in Oslo

async function setup(context, { start = START, bundle } = {}) {
  const root = bundle || await fs.mkdtemp(path.join(os.tmpdir(), 'folio-reminder-service-'))
  if (bundle) context.mock.timers.setTime(start)
  else context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start })
  const runtime = { bundleRoot: root, actionStore: createActionStore({ filePath: path.join(root, '.folio', 'actions.json') }) }
  const service = createReminderService(runtime, { timeZone: 'Europe/Oslo' })
  const fired = []
  service.onReminder((reminder) => fired.push(reminder))
  context.after(async () => {
    // fs.rm retries with timers, so give the hook real ones back.
    context.mock.timers.reset()
    await service.close()
    await runtime.actionStore.flush()
    if (!bundle) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { root, runtime, service, fired, store: runtime.actionStore }
}

test('the timer wakes for a due slot without polling, and re-plans at least every fifteen minutes', async (context) => {
  const { service, fired, store } = await setup(context)
  const item = store.addManual({ text: 'Send the budget', due: { date: '2026-11-12' } })
  service.start()
  context.mock.timers.tick(30 * MINUTE)
  assert.equal(fired.length, 0, 'the slot is at 09:00 local, not yet')
  context.mock.timers.tick(30 * MINUTE)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].title, 'Send the budget')
  assert.deepEqual(fired[0].actionIds, [item.id])
  context.mock.timers.tick(6 * 60 * MINUTE)
  assert.equal(fired.length, 1, 'never twice for the same due date')
})

test('a store change re-plans straight away instead of waiting for the next wake-up', async (context) => {
  const { service, fired, store } = await setup(context)
  service.start()
  const item = store.addManual({ text: 'Water the plants' })
  store.snooze(item.id, new Date(START + 2 * MINUTE).toISOString())
  context.mock.timers.tick(1_000)
  context.mock.timers.tick(3 * MINUTE)
  assert.equal(fired.length, 1, 'fired after the two-minute snooze, long before the 15-minute fallback')
  assert.match(fired[0].body, /Back from snooze/)
})

test('a restart does not repeat a reminder that already fired, and unseen reminders wait to be acked', async (context) => {
  const first = await setup(context)
  first.store.addManual({ text: 'Renew the passport', due: { date: '2026-11-12' } })
  first.service.start()
  context.mock.timers.tick(2 * 60 * MINUTE)
  assert.equal(first.fired.length, 1)
  assert.equal(first.service.pending().reminders.length, 1)
  await first.service.close()
  await first.store.flush()

  const second = await setup(context, { start: START + 3 * 60 * MINUTE, bundle: first.root })
  second.service.start()
  context.mock.timers.tick(60 * MINUTE)
  assert.equal(second.fired.length, 0, 'the ledger remembers')
  const [waiting] = second.service.pending().reminders
  assert.equal(waiting.title, 'Renew the passport')
  assert.equal(second.service.ack(waiting.id), true)
  assert.equal(second.service.ack(waiting.id), false, 'acking twice is harmless')
  assert.deepEqual(second.service.pending().reminders, [])
})

test('pending drops reminders whose action was dealt with elsewhere', async (context) => {
  const { service, fired, store } = await setup(context)
  const item = store.addManual({ text: 'Call the bank', due: { date: '2026-11-12' } })
  service.start()
  context.mock.timers.tick(2 * 60 * MINUTE)
  assert.equal(fired.length, 1)
  store.letGo(item.id)
  assert.deepEqual(service.pending().reminders, [])
})

test('settings changes take effect at once and level off silences everything', async (context) => {
  const { service, fired, store } = await setup(context)
  store.addManual({ text: 'Quiet one', due: { date: '2026-11-12' } })
  service.start()
  assert.equal(service.updateSettings({ level: 'off' }).level, 'off')
  context.mock.timers.tick(3 * 60 * MINUTE)
  assert.deepEqual(fired, [])
  service.updateSettings({ level: 'gentle' })
  context.mock.timers.tick(MINUTE)
  assert.equal(fired.length, 1, 'switching back on catches up on today')
})

test('an unanswered check-in fades the item silently once the fade window has passed', async (context) => {
  const { service, fired, store } = await setup(context)
  const item = store.addFromExtraction('/notes/a.md', [{ text: 'Maybe look into solar panels', anchor: { from: 0, to: 5, quote: 'solar' } }]).added[0]
  context.mock.timers.setTime(START + 15 * 24 * 60 * MINUTE)
  service.start()
  assert.deepEqual(service.pending().checkins.map((entry) => entry.actionId), [item.id])
  assert.equal(store.get(item.id).status, 'open', 'asking never changes the item')
  context.mock.timers.tick(6 * 24 * 60 * MINUTE)
  assert.equal(store.get(item.id).status, 'open', 'still within the answer window')
  context.mock.timers.tick(2 * 24 * 60 * MINUTE)
  assert.equal(store.get(item.id).status, 'faded')
  assert.deepEqual(fired, [], 'fading is silent')
  assert.deepEqual(service.pending().checkins, [])
})

test('answering the check-in with Keep stops the fade', async (context) => {
  const { service, store } = await setup(context)
  const item = store.addFromExtraction('/notes/a.md', [{ text: 'Maybe look into solar panels', anchor: { from: 0, to: 5, quote: 'solar' } }]).added[0]
  context.mock.timers.setTime(START + 15 * 24 * 60 * MINUTE)
  service.start()
  assert.equal(service.pending().checkins.length, 1)
  store.touch(item.id)
  context.mock.timers.tick(10 * 24 * 60 * MINUTE)
  assert.equal(store.get(item.id).status, 'open')
  assert.deepEqual(service.pending().checkins, [])
})
