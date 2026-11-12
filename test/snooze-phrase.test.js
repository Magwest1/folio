import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSnoozePhrase } from '../server/reminders/snooze-phrase.js'

const NOW = new Date('2026-11-12T10:00:00Z') // Thursday 11:00 in Oslo
const resolve = (phrase, timeZone = 'Europe/Oslo') => resolveSnoozePhrase(phrase, { now: NOW, timeZone }).toISOString()

test('plain English phrases resolve on the wall clock of the time zone', () => {
  assert.equal(resolve('tomorrow morning'), '2026-11-13T08:00:00.000Z', '09:00 local')
  assert.equal(resolve('tomorrow'), '2026-11-13T08:00:00.000Z', 'a day with no time defaults to 09:00')
  assert.equal(resolve('after lunch'), '2026-11-12T12:00:00.000Z', '13:00 local')
  assert.equal(resolve('tomorrow after lunch'), '2026-11-13T12:00:00.000Z')
  assert.equal(resolve('next week'), '2026-11-16T08:00:00.000Z', 'Monday 09:00')
  assert.equal(resolve('on Friday'), '2026-11-13T08:00:00.000Z')
  assert.equal(resolve('in 2 hours'), '2026-11-12T12:00:00.000Z')
  assert.equal(resolve('tonight'), '2026-11-12T17:00:00.000Z')
  assert.equal(resolve('Next Monday at 3pm'), '2026-11-16T14:00:00.000Z')
  assert.equal(resolve('tomorrow morning', 'America/New_York'), '2026-11-13T14:00:00.000Z')
})

test('Norwegian phrases work the same way', () => {
  assert.equal(resolve('neste uke'), '2026-11-16T08:00:00.000Z')
  assert.equal(resolve('i kveld'), '2026-11-12T17:00:00.000Z')
  assert.equal(resolve('i morgen tidlig'), '2026-11-13T08:00:00.000Z')
  assert.equal(resolve('etter lunsj'), '2026-11-12T12:00:00.000Z')
  assert.equal(resolve('i morgen etter lunsj'), '2026-11-13T12:00:00.000Z')
  assert.equal(resolve('om 3 timer'), '2026-11-12T13:00:00.000Z')
  assert.equal(resolve('på fredag'), '2026-11-13T08:00:00.000Z')
})

test('a time of day alone means today if it is ahead, otherwise tomorrow', () => {
  assert.equal(resolve('kl 14'), '2026-11-12T13:00:00.000Z')
  assert.equal(resolve('at 9am'), '2026-11-13T08:00:00.000Z')
})

test('phrases that cannot be read, or are in the past, give a friendly 400', () => {
  for (const phrase of ['', '   ', 'whenever', 'blorp', 'yesterday', 5, null]) {
    assert.throws(() => resolveSnoozePhrase(phrase, { now: NOW, timeZone: 'Europe/Oslo' }), (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /Try something like|Say when/)
      return true
    }, String(phrase))
  }
  assert.throws(() => resolve('tomorrow', 'Mars/Olympus'), (error) => error.status === 400)
})
