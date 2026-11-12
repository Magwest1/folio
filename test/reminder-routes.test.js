import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

async function startApp(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-reminder-routes-'))
  const first = path.join(dataRoot, 'first')
  const second = path.join(dataRoot, 'second')
  await Promise.all([fs.mkdir(first, { recursive: true }), fs.mkdir(second, { recursive: true })])
  await fs.writeFile(path.join(first, 'meeting.md'), '# Meeting\n\nSend the budget to Sam.\n')
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const one = await app.bundleManager.registry.setup({ name: 'First', markdownPath: first, source: 'existing' })
  const two = await app.bundleManager.registry.setup({ name: 'Second', markdownPath: second, source: 'existing' })
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await app.bundleManager.waitForBackground()
    await app.bundleManager.close()
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5 })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (bundle, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method, headers: { 'x-folio-bundle': bundle.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json() }
  }
  return { app, one, two, call }
}

test('snoozing in plain words resolves the phrase in the sent time zone and returns the time', async (context) => {
  const { one, call } = await startApp(context)
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-12T12:00:00Z') })
  const { body: item } = await call(one, 'POST', '/api/actions', { text: 'Call Sam' })
  const morning = await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'tomorrow morning', timeZone: 'Europe/Oslo' })
  assert.equal(morning.status, 200)
  assert.equal(morning.body.status, 'snoozed')
  assert.equal(morning.body.until, '2026-11-13T08:00:00.000Z')
  assert.equal(morning.body.snoozedUntil, morning.body.until)
  const norwegian = await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'neste uke', timeZone: 'Europe/Oslo' })
  assert.equal(norwegian.body.until, '2026-11-16T08:00:00.000Z')
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'after lunch', timeZone: 'America/New_York' })).body.until, '2026-11-12T18:00:00.000Z')
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/snooze`, { until: '2999-01-01' })).body.until, '2999-01-01T00:00:00.000Z', 'explicit times still work')

  const unreadable = await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'blorp', timeZone: 'Europe/Oslo' })
  assert.equal(unreadable.status, 400)
  assert.match(unreadable.body.error, /Try something like/)
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'yesterday', timeZone: 'Europe/Oslo' })).status, 400)
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: 'tomorrow', timeZone: 'Not/AZone' })).status, 400)
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/snooze`, { phrase: '' })).status, 400)
  assert.equal((await call(one, 'GET', `/api/actions/${item.id}`)).body.snoozedUntil, '2999-01-01T00:00:00.000Z', 'a refused phrase changes nothing')
})

test('reminder settings are per bundle, validated and saved', async (context) => {
  const { app, one, two, call } = await startApp(context)
  assert.equal((await call(one, 'GET', '/api/reminders/settings')).body.level, 'gentle')
  const saved = await call(one, 'PUT', '/api/reminders/settings', { level: 'normal', morningBrief: { enabled: true, time: '07:30' }, quietHours: { enabled: false } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.level, 'normal')
  assert.deepEqual((await call(one, 'GET', '/api/reminders/settings')).body.morningBrief, { enabled: true, time: '07:30' })
  assert.equal((await call(two, 'GET', '/api/reminders/settings')).body.level, 'gentle')
  for (const body of [{ level: 'shouting' }, { quietHours: { start: '9pm' } }, { stillRelevantAfterDays: 0 }]) {
    assert.equal((await call(one, 'PUT', '/api/reminders/settings', body)).status, 400, JSON.stringify(body))
  }
  const runtime = app.bundleManager.runtimeFor(one)
  await runtime.reminders.flush()
  const file = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'reminders.json'), 'utf8'))
  assert.equal(file.settings.level, 'normal')
})

test('due reminders are served once until acked, and dismissed items disappear from them', async (context) => {
  const previousZone = process.env.TZ
  process.env.TZ = 'UTC'
  context.after(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone })
  const { app, one, call } = await startApp(context)
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-12T07:00:00Z') })
  const dated = (await call(one, 'POST', '/api/actions', { text: 'Pay the invoice', due: { date: '2026-11-12' } })).body
  await call(one, 'POST', '/api/actions', { text: 'Undated thing' })
  const runtime = app.bundleManager.runtimeFor(one)
  assert.deepEqual((await call(one, 'GET', '/api/reminders/pending')).body.reminders, [])
  context.mock.timers.setTime(Date.parse('2026-11-12T12:00:00Z'))
  runtime.reminders.replan()
  const { body } = await call(one, 'GET', '/api/reminders/pending')
  assert.equal(body.reminders.length, 1, 'only the dated item')
  assert.equal(body.reminders[0].title, 'Pay the invoice')
  assert.deepEqual(body.reminders[0].actionIds, [dated.id])
  assert.deepEqual(body.checkins, [])
  runtime.reminders.replan()
  assert.equal((await call(one, 'GET', '/api/reminders/pending')).body.reminders.length, 1, 'replanning never repeats it')
  assert.deepEqual((await call(one, 'POST', `/api/reminders/${body.reminders[0].id}/ack`)).body, { acked: true })
  assert.deepEqual((await call(one, 'GET', '/api/reminders/pending')).body.reminders, [])
  assert.deepEqual((await call(one, 'POST', '/api/reminders/rem_unknown/ack')).body, { acked: false })

  // Not important is final: it never comes back as a reminder or on Home.
  assert.equal((await call(one, 'POST', `/api/actions/${dated.id}/let-go`)).body.status, 'let-go')
  runtime.reminders.replan()
  assert.deepEqual((await call(one, 'GET', '/api/reminders/pending')).body.reminders, [])
  assert.equal((await call(one, 'GET', '/api/actions')).body.some((item) => item.id === dated.id), false)
})

test('Keep resets the quiet clock without touching anything else', async (context) => {
  const { one, call } = await startApp(context)
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T08:00:00Z') })
  const { body: item } = await call(one, 'POST', '/api/actions', { text: 'Think about the garden' })
  context.mock.timers.setTime(Date.parse('2026-11-20T08:00:00Z'))
  const kept = await call(one, 'POST', `/api/actions/${item.id}/keep`)
  assert.equal(kept.status, 200)
  assert.equal(kept.body.status, 'open')
  assert.equal(kept.body.touchedAt, '2026-11-20T08:00:00.000Z')
  await call(one, 'POST', `/api/actions/${item.id}/complete`)
  assert.equal((await call(one, 'POST', `/api/actions/${item.id}/keep`)).status, 409)
})

test('clear everything from a note is one undoable batch', async (context) => {
  const { app, one, two, call } = await startApp(context)
  const make = async (text, noteId, extra = {}) => (await call(one, 'POST', '/api/actions', { text, noteId, ...extra })).body.id
  const [a, b, snoozed, other, done] = [
    await make('Send the budget', '/meeting.md'), await make('Book the room', '/meeting.md'), await make('Later one', '/meeting.md'),
    await make('Elsewhere', '/other.md'), await make('Already done', '/meeting.md'),
  ]
  await call(one, 'POST', `/api/actions/${snoozed}/snooze`, { until: '2999-01-01' })
  await call(one, 'POST', `/api/actions/${done}/complete`)

  const cleared = await call(one, 'POST', '/api/actions/clear-note', { noteId: '/meeting.md' })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body.ids.sort(), [a, b, snoozed].sort())
  const remaining = (await call(one, 'GET', '/api/actions')).body.map((item) => item.id)
  assert.deepEqual(remaining, [other])
  assert.equal((await call(one, 'GET', `/api/actions/${a}`)).body.status, 'let-go')
  assert.equal((await call(one, 'GET', `/api/actions/${done}`)).body.status, 'done', 'finished items are left alone')
  assert.equal((await call(two, 'GET', '/api/actions')).body.length, 0, 'other bundles are untouched')
  const store = app.bundleManager.runtimeFor(one).actionStore
  assert.equal(store.feedbackLog().filter((entry) => entry.type === 'not-important').length, 3)

  assert.deepEqual((await call(one, 'POST', '/api/actions/clear-note', { noteId: '/meeting.md' })).body.ids, [], 'clearing twice is harmless')
  const undone = await call(one, 'POST', '/api/actions/undo-batch', { ids: [...cleared.body.ids, done, 'act_missing'] })
  assert.deepEqual(undone.body.ids.sort(), [a, b, snoozed].sort(), 'only the let-go items come back')
  assert.deepEqual((await call(one, 'GET', '/api/actions')).body.map((item) => item.id).sort(), [a, b, snoozed, other].sort())
  assert.equal((await call(one, 'GET', `/api/actions/${snoozed}`)).body.status, 'snoozed')
  assert.equal(store.feedbackLog().filter((entry) => entry.type === 'not-important').length, 0)

  for (const [url, body] of [['/api/actions/clear-note', {}], ['/api/actions/clear-note', { noteId: 4 }], ['/api/actions/undo-batch', { ids: 'x' }], ['/api/actions/undo-batch', { ids: [4] }]])
    assert.equal((await call(one, 'POST', url, body)).status, 400, url)
})
