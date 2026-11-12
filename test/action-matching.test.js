import assert from 'node:assert/strict'
import test from 'node:test'

import { askCompletion, parseCompletionAnswer } from '../server/actions/matching/ask.js'
import { COMPLETION_THRESHOLDS, findCompletion, otherSubject, reportsNoCompletion } from '../server/actions/matching/completion.js'
import { findRepeat } from '../server/actions/matching/repeat.js'
import { compareDue, comparePeople, contentWords, cosine, lexicalSimilarity, stem, textSimilarity } from '../server/actions/matching/similarity.js'
import { PAST_TO_BASE_EN, PAST_TO_BASE_NO } from '../server/actions/matching/verbs.js'

let counter = 0
const action = (text, extra = {}) => ({
  id: `a${++counter}`, text, person: null, due: null, kind: 'task', status: 'open', origin: 'auto', createdAt: '2026-11-01T08:00:00Z', ...extra,
})
const NOW = new Date('2026-11-12T10:00:00Z')

test('past tense and base forms meet at one stem in English and Norwegian', () => {
  assert.equal(PAST_TO_BASE_EN.sent, 'send')
  assert.equal(PAST_TO_BASE_NO.ringte, 'ring')
  for (const [past, base] of [['sent', 'send'], ['called', 'call'], ['wrote', 'write'], ['paid', 'pay'], ['booked', 'booking'], ['emailed', 'email'],
    ['sendte', 'sende'], ['ringte', 'ringe'], ['bestilte', 'bestille'], ['oppdaterte', 'oppdatere'], ['skrev', 'skrive'], ['betalte', 'betal'], ['kjøpt', 'kjøpe']]) {
    assert.equal(stem(past), stem(base), `${past} / ${base}`)
  }
  assert.deepEqual(contentWords('Sent the budget to Anna', ['Anna']), contentWords('Send the budget to Anna', ['Anna']))
  assert.deepEqual(contentWords('Ringte Kari om leiekontrakten i går', ['Kari']), contentWords('Ringe Kari om leiekontrakten', ['Kari']))
})

test('content words drop stop words, time words and list markers', () => {
  assert.deepEqual(contentWords('- [x] Please remember to send the report by Friday'), ['send', 'report'])
  assert.deepEqual(contentWords('Husk å sende rapporten innen fredag'), ['send', 'rapport'])
})

test('lexical similarity needs more than one shared word unless a side has a single content word', () => {
  assert.ok(lexicalSimilarity('Send the budget to Anna', 'Sent the budget to Anna', { exclude: ['Anna'] }).score > 0.99)
  assert.ok(lexicalSimilarity('Send the keys', 'Send the budget', {}).score <= 0.3)
  assert.ok(lexicalSimilarity('Ringte Kari', 'Ringe Kari', { exclude: ['Kari'] }).score > 0.99, 'a lone verb still matches')
  assert.ok(lexicalSimilarity('Review the design doc for the mobile app', 'Review the design doc for the billing service').score < 0.6)
})

test('embeddings are blended in but cannot create a match from nothing', () => {
  const embeddings = new Map([['Email Anna the numbers', [1, 0]], ['Send the budget to Anna', [0.9, 0.1]], ['Water the plants', [0.95, 0.05]]])
  assert.ok(cosine([1, 0], [1, 0]) > 0.999)
  assert.equal(cosine([1], [1, 2]), null)
  const paraphrase = textSimilarity('Email Anna the numbers', 'Send the budget to Anna', { embeddings, exclude: ['Anna'] })
  assert.equal(paraphrase.mode, 'embedding')
  assert.ok(paraphrase.cosine > 0.9)
  assert.ok(textSimilarity('Water the plants', 'Send the budget to Anna', { embeddings }).score <= 0.4, 'no shared word: capped')
  assert.equal(textSimilarity('Email Anna the numbers', 'Send the budget to Anna').mode, 'lexical')
})

test('people compare case-insensitively, ignoring diacritics, by first name', () => {
  assert.equal(comparePeople('Anna', 'anna'), 'same')
  assert.equal(comparePeople('Åse', 'Ase'), 'same')
  assert.equal(comparePeople('Anna Berg', 'Anna'), 'same')
  assert.equal(comparePeople('Anna Berg', 'Anna Hansen'), 'different')
  assert.equal(comparePeople('Anna', 'Ola'), 'different')
  assert.equal(comparePeople('Anna', null), 'unknown')
  assert.equal(comparePeople(null, ''), 'none')
})

test('due dates are compatible when equal, overlapping or one side is undated', () => {
  const friday = { date: '2026-11-13' }
  assert.equal(compareDue(friday, { date: '2026-11-13', time: '10:00' }), 'equal')
  assert.equal(compareDue(friday, { window: { start: '2026-11-09', end: '2026-11-15' } }), 'overlap')
  assert.equal(compareDue(friday, null), 'unknown')
  assert.equal(compareDue(friday, { date: '2026-12-20' }), 'conflict')
})

test('findRepeat merges the same commitment in other words, English and Norwegian', () => {
  const open = [action('Send the budget to Anna by Friday', { person: 'Anna', due: { date: '2026-11-13' } }), action('Book the meeting room')]
  const hit = findRepeat({ text: 'I need to send the budget to Anna this week', person: 'Anna', due: { window: { start: '2026-11-09', end: '2026-11-15' } } }, open)
  assert.equal(hit.action, open[0])
  assert.ok(hit.reasons.some((reason) => reason.startsWith('person same')))
  const norwegian = [action('Ringe tannlegen og bestille time')]
  assert.equal(findRepeat({ text: 'Husk å ringe tannlegen for å bestille time', person: null, due: null }, norwegian)?.action, norwegian[0])
})

test('findRepeat refuses another person, a conflicting date, similar but different work and closed actions', () => {
  const contract = action('Send the contract to Harper', { person: 'Harper' })
  assert.equal(findRepeat({ text: 'Send the contract to Elena', person: 'Elena', due: null }, [contract]), null)
  const bill = action('Pay the electricity bill by 20 November', { due: { date: '2026-11-20' } })
  assert.equal(findRepeat({ text: 'Pay the electricity bill by 20 December', person: null, due: { date: '2026-12-20' } }, [bill]), null)
  const mobile = action('Review the design doc for the mobile app')
  assert.equal(findRepeat({ text: 'Review the design doc for the billing service', person: null, due: null }, [mobile]), null)
  for (const status of ['done', 'let-go', 'rejected', 'faded']) {
    assert.equal(findRepeat({ text: 'Submit the timesheet to Harper', person: 'Harper', due: null }, [action('Submit the timesheet to Harper', { person: 'Harper', status })]), null, status)
  }
  assert.equal(findRepeat({ text: 'Submit the timesheet', person: 'Harper', due: null }, [action('Submit the timesheet', { status: 'snoozed' })])?.score > 0.8, true, 'snoozed actions can match')
})

test('findRepeat asks for more evidence when only one side names a person', () => {
  const open = [action('Send the budget to the board')]
  assert.equal(findRepeat({ text: 'Send the budget to the board', person: 'Anna', due: null }, open)?.action, open[0], 'identical text')
  assert.equal(findRepeat({ text: 'Send the budget to the board members', person: 'Anna', due: null }, open), null, 'near text is not enough')
})

test('findCompletion bridges tense in English and Norwegian and auto-applies only clear matches', () => {
  const english = findCompletion({ text: 'Sent the budget to Anna this morning.', person: 'Anna' }, [action('Send the budget to Anna', { person: 'Anna' })], { now: NOW })
  assert.equal(english.auto, true)
  assert.equal(english.ambiguous, false)
  const norwegian = findCompletion({ text: 'Ringte Kari i går.', person: null }, [action('Ringe Kari', { person: 'Kari' })], { now: NOW })
  assert.equal(norwegian.auto, true, 'the sentence names Kari even though the detector did not')
  const unknownPerson = findCompletion({ text: 'Sent the budget to Anna.', person: 'Anna' }, [action('Send the budget')], { now: NOW })
  assert.equal(unknownPerson.auto, false, 'only one side names a person')
  assert.ok(unknownPerson.score >= COMPLETION_THRESHOLDS.suggest)
})

test('findCompletion picks the right action among similar ones and reports a tie as nothing', () => {
  const leak = action('Call the plumber about the leak')
  const quote = action('Call the plumber about the quote')
  assert.equal(findCompletion({ text: 'Called the plumber about the leak.', person: null }, [leak, quote], { now: NOW }).action, leak)
  assert.equal(findCompletion({ text: 'Called the plumber.', person: null }, [leak, quote], { now: NOW }), null)
  const anna = action('Send the budget to Anna', { person: 'Anna' })
  const ola = action('Send the budget to Ola', { person: 'Ola' })
  const hit = findCompletion({ text: 'Sent the budget to Anna.', person: 'Anna' }, [ola, anna], { now: NOW })
  assert.equal(hit.action, anna)
  assert.equal(hit.auto, true)
})

test('findCompletion ignores sentences that do not report finished work by the writer', () => {
  const open = [action('Send the invoice to Harper', { person: 'Harper' }), action('Write the quarterly report'), action('Send the slides to Elena', { person: 'Elena' })]
  for (const text of ["I haven't sent the invoice to Harper yet.", 'Har ikke sendt fakturaen til Harper ennå.', 'Started the quarterly report, about half done.', 'Begynte på rapporten, er halvveis.',
    'I will send the invoice to Harper on Monday.', 'Did I send the invoice to Harper?', 'Anna sent her slides to Elena.', 'Anna har sendt sine til Elena.']) {
    assert.equal(findCompletion({ text, person: null }, open, { now: NOW }), null, text)
  }
  assert.equal(reportsNoCompletion('Sent it, not yet confirmed'), true)
  assert.equal(otherSubject('Anna har sendt sine til Elena.'), 'Anna')
  assert.equal(otherSubject('I finally sent it, and she confirmed.'), null)
  assert.equal(otherSubject('Sent the budget to Anna.'), null)
})

test('findCompletion lets a person finish what I am waiting on from them, as a suggestion', () => {
  const waiting = action('Waiting for Anna to send the budget', { kind: 'waiting-on', person: 'Anna' })
  const hit = findCompletion({ text: 'Anna sent the budget.', person: 'Anna' }, [waiting], { now: NOW })
  assert.equal(hit.action, waiting)
  assert.equal(hit.auto, false)
})

test('findCompletion respects time, status and origin', () => {
  const open = action('Send the budget to Anna', { person: 'Anna', createdAt: '2026-11-13T00:00:00Z' })
  const text = { text: 'Sent the budget to Anna.', person: 'Anna' }
  assert.equal(findCompletion(text, [open], { now: NOW }), null, 'dated before the action existed')
  assert.ok(findCompletion(text, [{ ...open, createdAt: '2026-11-01T00:00:00Z' }], { now: NOW }))
  assert.equal(findCompletion(text, [{ ...open, createdAt: '2026-11-13T00:00:00Z', sourceAt: '2026-11-10T00:00:00Z' }], { now: NOW }).auto, true, 'the source note time wins over the creation time')
  for (const status of ['done', 'let-go', 'rejected', 'faded']) assert.equal(findCompletion(text, [{ ...open, createdAt: '2026-11-01T00:00:00Z', status }], { now: NOW }), null, status)
  assert.equal(findCompletion(text, [{ ...open, createdAt: '2026-11-01T00:00:00Z', origin: 'todo-list' }], { now: NOW }), null, 'todo list lines are managed in that file')
})

test('findCompletion marks the middle band ambiguous and does not suggest a near miss', () => {
  const chairs = [action('Order the office chairs')]
  const near = findCompletion({ text: 'Ordered the office desks.', person: null }, chairs, { now: NOW })
  assert.equal(near.ambiguous, true)
  assert.equal(near.auto, false)
  assert.equal(findCompletion({ text: 'Washed the car.', person: null }, chairs, { now: NOW }), null)
})

test('the completion question parses strictly and fails safe', async () => {
  assert.equal(parseCompletionAnswer('{"done": true}'), true)
  assert.equal(parseCompletionAnswer('Sure: {"done":true}'), true)
  for (const bad of ['{"done": false}', '{"done": "yes"}', '{"done": true, "extra": 1}', 'maybe', '', null, '{"done": tru']) assert.equal(parseCompletionAnswer(bad), false, String(bad))
  assert.equal(await askCompletion(async () => ({ text: '{"done":true}' }), 'Sent it', 'Send it'), true)
  assert.equal(await askCompletion(async () => { throw new Error('model crashed') }, 'Sent it', 'Send it'), false)
  assert.equal(await askCompletion(async () => ({ text: 'garbage' }), 'Sent it', 'Send it'), false)
  assert.equal(await askCompletion(() => new Promise(() => {}), 'Sent it', 'Send it', { timeoutMs: 10 }), false)
  assert.equal(await askCompletion(null, 'Sent it', 'Send it'), false)
})

test('a ticked checkbox reports completion without a past tense verb', () => {
  const open = [action('Book the venue for the offsite')]
  assert.equal(findCompletion({ text: 'Book the venue for the offsite', person: null }, open, { now: NOW }), null)
  assert.equal(findCompletion({ text: 'Book the venue for the offsite', person: null, checked: true }, open, { now: NOW }).auto, true)
})
