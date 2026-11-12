import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_SETTINGS, createReminderState, mergeSettings } from '../server/reminders/settings.js'

const temp = async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-reminders-'))
  context.after(() => fs.rm(dir, { recursive: true, force: true }))
  return path.join(dir, '.folio', 'reminders.json')
}

test('defaults are gentle, with quiet hours on and the brief off', async (context) => {
  const state = createReminderState(await temp(context))
  assert.deepEqual(state.settings(), DEFAULT_SETTINGS)
  assert.equal(state.settings().level, 'gentle')
  assert.deepEqual(state.settings().quietHours, { enabled: true, start: '21:00', end: '08:00' })
  assert.deepEqual(state.settings().morningBrief, { enabled: false, time: '08:30' })
  assert.equal(state.settings().stillRelevantAfterDays, 14)
  assert.equal(state.settings().fadeAfterDays, 7)
})

test('settings, ledger and pending survive a restart and are written atomically', async (context) => {
  const file = await temp(context)
  const first = createReminderState(file)
  first.update({ level: 'normal', quietHours: { enabled: false }, morningBrief: { enabled: true, time: '07:45' }, stillRelevantAfterDays: 30 })
  first.record(['fire:a:due:2026-11-12'])
  first.setPending([{ id: 'rem_1', actionIds: ['a'], keys: ['fire:a:due:2026-11-12'] }])
  await first.flush()
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp')), [])
  const second = createReminderState(file)
  assert.equal(second.settings().level, 'normal')
  assert.equal(second.settings().quietHours.enabled, false)
  assert.equal(second.settings().quietHours.start, '21:00', 'a partial update keeps the other fields')
  assert.deepEqual(second.settings().morningBrief, { enabled: true, time: '07:45' })
  assert.equal(second.settings().stillRelevantAfterDays, 30)
  assert.ok(second.ledger()['fire:a:due:2026-11-12'])
  assert.equal(second.pending()[0].id, 'rem_1')
})

test('bad updates are refused with a 400 and change nothing', async (context) => {
  const state = createReminderState(await temp(context))
  for (const patch of [{ level: 'loud' }, { quietHours: { start: '25:00' } }, { morningBrief: { time: 'soon' } },
    { stillRelevantAfterDays: 0 }, { fadeAfterDays: 2.5 }, 'nope', [], { quietHours: 'always' }]) {
    assert.throws(() => state.update(patch), (error) => error.status === 400, JSON.stringify(patch))
  }
  assert.deepEqual(state.settings(), DEFAULT_SETTINGS)
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { level: 'off', fadeAfterDays: -1 }), (error) => error.status === 400)
})

test('an unreadable file is kept aside and replaced by defaults; a partly bad file keeps its good fields', async (context) => {
  const file = await temp(context)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{ not json')
  const original = console.error
  console.error = () => {}
  try {
    const state = createReminderState(file, { now: () => new Date('2026-11-12T10:00:00Z') })
    assert.deepEqual(state.settings(), DEFAULT_SETTINGS)
    const kept = (await fs.readdir(path.dirname(file))).filter((name) => name.includes('.corrupt-'))
    assert.equal(kept.length, 1)
    assert.equal(await fs.readFile(path.join(path.dirname(file), kept[0]), 'utf8'), '{ not json')
    state.update({ level: 'off' })
    await state.flush()
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).settings.level, 'off')
  } finally { console.error = original }

  await fs.writeFile(file, JSON.stringify({
    version: 1, settings: { level: 'normal', quietHours: { enabled: false, start: 'late' }, fadeAfterDays: 'x', morningBrief: { enabled: true, time: '07:00' } },
    ledger: { good: '2026-11-01T00:00:00Z', bad: 5 }, pending: 'oops',
  }))
  const partial = createReminderState(file)
  assert.equal(partial.settings().level, 'normal')
  assert.equal(partial.settings().quietHours.enabled, false)
  assert.equal(partial.settings().quietHours.start, '21:00')
  assert.equal(partial.settings().fadeAfterDays, 7)
  assert.deepEqual(partial.settings().morningBrief, { enabled: true, time: '07:00' })
  assert.deepEqual(Object.keys(partial.ledger()), ['good'])
  assert.deepEqual(partial.pending(), [])
})

test('the ledger forgets entries older than four months', async (context) => {
  const state = createReminderState(await temp(context))
  state.record(['old'], new Date('2026-01-01T00:00:00Z'))
  state.record(['new'], new Date('2026-11-12T00:00:00Z'))
  assert.deepEqual(Object.keys(state.ledger()), ['new'])
  await state.flush()
})
