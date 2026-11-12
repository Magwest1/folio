import assert from 'node:assert/strict'
import test from 'node:test'

import { fold, groundOutput, groundPerson, groundTime, summaryProblems } from '../server/actions/extraction/grounding.js'

const NOW = new Date('2026-11-12T09:30:00+01:00')
const ctx = { now: NOW, timeZone: 'Europe/Oslo' }
const span = (text, from = 100) => ({ from, to: from + text.length, text })
const out = (extra) => ({ isAction: true, actor: 'me', summary: 'Send the invoice', person: null, timePhrase: null, ...extra })

test('fold handles case and Norwegian letters one-to-one', () => {
  assert.equal(fold('ÅSE Ørjan Æsir'), 'ase orjan asir')
  assert.equal(fold('Søren').length, 5)
})

test('person must occur in the span as a whole word, case-insensitively', () => {
  assert.equal(groundPerson('harper', 'Send invoice to Harper by Friday'), 'Harper')
  assert.equal(groundPerson('Åse', 'Ring Åse i morgen'), 'Åse')
  assert.equal(groundPerson('ase', 'Ring Åse i morgen'), 'Åse')
  assert.equal(groundPerson('Søren', 'Spør søren om tilbudet'), 'søren')
  assert.equal(groundPerson('Sofia', 'Call Sofiane tomorrow'), null)
  assert.equal(groundPerson('Marcus', 'Call Sofia tomorrow'), null)
})

test('time phrase must occur in the span and resolve with absolute offsets', () => {
  const text = 'Send invoice to Harper by Friday'
  const hit = groundTime('Friday', span(text), ctx)
  assert.deepEqual(hit.due, { date: '2026-11-13' })
  assert.equal(hit.from, 100 + text.indexOf('Friday'))
  assert.equal(groundTime('fredag', span(text), ctx), null, 'not in span')
  assert.equal(groundTime('soon', span('Do it soon'), ctx), null, 'not resolvable')
  assert.deepEqual(groundTime('neste uke', span('Sende rapporten neste uke'), ctx).due, { window: { start: '2026-11-16', end: '2026-11-22' } })
  assert.deepEqual(groundTime('tomorrow at 3pm', span('Call back tomorrow at 3pm'), ctx).due, { date: '2026-11-13', time: '15:00' })
})

test('summary may not introduce names or digits', () => {
  assert.deepEqual(summaryProblems('Send the invoice to Harper', 'send invoice to harper by friday'), [])
  assert.deepEqual(summaryProblems('Send the invoice to Marcus', 'Send invoice to Harper'), ['name:Marcus'])
  assert.deepEqual(summaryProblems('Pay 500 kr to Harper', 'Pay Harper 300 kr'), ['number:500'])
  assert.deepEqual(summaryProblems('Send invoice', 'Send invoice'), [])
  assert.deepEqual(summaryProblems('Ring Åse', 'Ring ase'), [])
})

test('groundOutput clears bad fields and rejects invented summaries', () => {
  const text = 'Send invoice to Harper by Friday'
  const ok = groundOutput(out({ person: 'Harper', timePhrase: 'Friday' }), span(text), ctx)
  assert.equal(ok.person, 'Harper')
  assert.deepEqual(ok.timeHit.due, { date: '2026-11-13' })
  assert.deepEqual(ok.issues, [])
  assert.equal(ok.rejected, false)

  const bad = groundOutput(out({ person: 'Marcus', timePhrase: 'next month', summary: 'Send invoice to Marcus by 15' }), span(text), ctx)
  assert.equal(bad.person, null)
  assert.equal(bad.timeHit, null)
  assert.equal(bad.rejected, true)
  assert.deepEqual(bad.issues, ['person-not-in-span:Marcus', 'time-unresolvable:next month', 'summary-name:Marcus', 'summary-number:15'])
})

test('non-action answers are not checked for summaries', () => {
  assert.equal(groundOutput({ isAction: false, actor: 'me', summary: '', person: null, timePhrase: null }, span('Done.'), ctx).rejected, false)
})
