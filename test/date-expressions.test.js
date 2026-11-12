import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTimeExpressions } from '../server/knowledge/date-expressions.js'

// Thursday 2026-11-12 in Oslo.
const oslo = { now: new Date('2026-11-12T10:00:00.000Z'), timeZone: 'Europe/Oslo' }

function pick(hit) {
  const { phrase, precision, date, time, window, deadline } = hit
  return { phrase, precision, ...(date && { date }), ...(time && { time }), ...(window && { window }), deadline }
}

const day = (phrase, date, deadline = false) => ({ phrase, precision: 'day', date, deadline })
const datetime = (phrase, date, time, deadline = false) => ({ phrase, precision: 'datetime', date, time, deadline })
const window = (phrase, precision, start, end, deadline = false) => ({ phrase, precision, window: { start, end }, deadline })

const cases = [
  // relative days
  ['Do it today', [day('today', '2026-11-12')]],
  ['Do it tomorrow', [day('tomorrow', '2026-11-13')]],
  ['Sent it yesterday', [day('yesterday', '2026-11-11')]],
  ['Gjør det i dag', [day('i dag', '2026-11-12')]],
  ['Gjør det i morgen', [day('i morgen', '2026-11-13')]],
  ['Det skjedde i går', [day('i går', '2026-11-11')]],
  ['Vi ses i overmorgen', [day('i overmorgen', '2026-11-14')]],
  ['Back the day after tomorrow', [day('the day after tomorrow', '2026-11-14')]],
  // weekdays
  ['See you Friday', [day('Friday', '2026-11-13')]],
  ['See you Thursday', [day('Thursday', '2026-11-19')]],
  ['Møt meg på mandag', [day('mandag', '2026-11-16')]],
  ['next Friday', [day('next Friday', '2026-11-13')]],
  ['this Thursday', [day('this Thursday', '2026-11-12')]],
  ['this Monday', [day('this Monday', '2026-11-16')]],
  ['last Monday', [day('last Monday', '2026-11-09')]],
  ['neste onsdag', [day('neste onsdag', '2026-11-18')]],
  ['kommende fredag', [day('kommende fredag', '2026-11-13')]],
  ['forrige tirsdag', [day('forrige tirsdag', '2026-11-10')]],
  ['Wed works', [day('Wed', '2026-11-18')]],
  // weeks and months
  ['next week', [window('next week', 'week', '2026-11-16', '2026-11-22')]],
  ['this week', [window('this week', 'week', '2026-11-09', '2026-11-15')]],
  ['neste uke', [window('neste uke', 'week', '2026-11-16', '2026-11-22')]],
  ['denne uka', [window('denne uka', 'week', '2026-11-09', '2026-11-15')]],
  ['neste uken', [window('neste uken', 'week', '2026-11-16', '2026-11-22')]],
  ['next month', [window('next month', 'month', '2026-12-01', '2026-12-31')]],
  ['neste måned', [window('neste måned', 'month', '2026-12-01', '2026-12-31')]],
  ['by end of the week', [window('end of the week', 'week', '2026-11-13', '2026-11-15', true)]],
  ['by end of month', [window('end of month', 'month', '2026-11-30', '2026-11-30', true)]],
  ['innen slutten av måneden', [window('slutten av måneden', 'month', '2026-11-30', '2026-11-30', true)]],
  ['slutten av uka', [window('slutten av uka', 'week', '2026-11-13', '2026-11-15')]],
  ['by end of day', [day('end of day', '2026-11-12', true)]],
  ['this weekend', [window('this weekend', 'range', '2026-11-14', '2026-11-15')]],
  ['neste helg', [window('neste helg', 'range', '2026-11-21', '2026-11-22')]],
  ['before Easter', [window('Easter', 'range', '2027-03-25', '2027-03-29', true)]],
  ['før påske', [window('påske', 'range', '2027-03-25', '2027-03-29', true)]],
  // offsets
  ['in two weeks', [day('in two weeks', '2026-11-26')]],
  ['in 3 days', [day('in 3 days', '2026-11-15')]],
  ['om tre dager', [day('om tre dager', '2026-11-15')]],
  ['om to uker', [day('om to uker', '2026-11-26')]],
  ['om en måned', [day('om en måned', '2026-12-12')]],
  ['within 5 days', [day('within 5 days', '2026-11-17', true)]],
  ['innen to dager', [day('innen to dager', '2026-11-14', true)]],
  ['in 30 minutes', [datetime('in 30 minutes', '2026-11-12', '11:30')]],
  ['om 2 timer', [datetime('om 2 timer', '2026-11-12', '13:00')]],
  // explicit dates
  ['2026-11-20', [day('2026-11-20', '2026-11-20')]],
  ['20.11', [day('20.11', '2026-11-20')]],
  ['20.11.2026', [day('20.11.2026', '2026-11-20')]],
  ['5.3.27', [day('5.3.27', '2027-03-05')]],
  ['20/11', [day('20/11', '2026-11-20')]],
  ['12/25', [day('12/25', '2026-12-25')]],
  ['20. november', [day('20. november', '2026-11-20')]],
  ['november 20', [day('november 20', '2026-11-20')]],
  ['20 nov', [day('20 nov', '2026-11-20')]],
  ['Nov 20th', [day('Nov 20th', '2026-11-20')]],
  ['the 3rd of March', [day('3rd of March', '2027-03-03')]],
  ['5. januar', [day('5. januar', '2027-01-05')]],
  ['Jan 5, 2028', [day('Jan 5, 2028', '2028-01-05')]],
  ['12. nov', [day('12. nov', '2026-11-12')]],
  ['11. november', [day('11. november', '2027-11-11')]],
  ['29. februar', [day('29. februar', '2028-02-29')]],
  ['1. des.', [day('1. des', '2026-12-01')]],
  ['May 5', [day('May 5', '2027-05-05')]],
  // times
  ['tomorrow at 3pm', [datetime('tomorrow at 3pm', '2026-11-13', '15:00')]],
  ['tomorrow at 15:00', [datetime('tomorrow at 15:00', '2026-11-13', '15:00')]],
  ['fredag kl 10', [datetime('fredag kl 10', '2026-11-13', '10:00')]],
  ['fredag kl. 14:30', [datetime('fredag kl. 14:30', '2026-11-13', '14:30')]],
  ['i morgen klokka 9', [datetime('i morgen klokka 9', '2026-11-13', '09:00')]],
  ['kl 10 på fredag', [datetime('kl 10 på fredag', '2026-11-13', '10:00')]],
  ['Friday 3:30 pm', [datetime('Friday 3:30 pm', '2026-11-13', '15:30')]],
  ['12 am meeting 12:30 pm', [{ phrase: '12 am', precision: 'datetime', time: '00:00', deadline: false }, { phrase: '12:30 pm', precision: 'datetime', time: '12:30', deadline: false }]],
  ['fredag 10:00', [datetime('fredag 10:00', '2026-11-13', '10:00')]],
  ['2026-11-20T14:00', [datetime('2026-11-20T14:00', '2026-11-20', '14:00')]],
  ['at 3pm', [{ phrase: 'at 3pm', precision: 'datetime', time: '15:00', deadline: false }]],
  ['kl 14', [{ phrase: 'kl 14', precision: 'datetime', time: '14:00', deadline: false }]],
  // parts of day
  ['tomorrow morning', [datetime('tomorrow morning', '2026-11-13', '09:00')]],
  ['i morgen tidlig', [datetime('i morgen tidlig', '2026-11-13', '09:00')]],
  ['tonight', [datetime('tonight', '2026-11-12', '18:00')]],
  ['i kveld', [datetime('i kveld', '2026-11-12', '18:00')]],
  ['fredag ettermiddag', [datetime('fredag ettermiddag', '2026-11-13', '15:00')]],
  ['this afternoon', [datetime('this afternoon', '2026-11-12', '15:00')]],
  ['torsdag 19. november kl. 14.30', [datetime('torsdag 19. november kl. 14.30', '2026-11-19', '14:30')]],
  ['Friday, 20 November at 9am', [datetime('Friday, 20 November at 9am', '2026-11-20', '09:00')]],
  ['Friday at 10', [datetime('Friday at 10', '2026-11-13', '10:00')]],
  // deadlines
  ['by Friday', [day('Friday', '2026-11-13', true)]],
  ['before next week', [window('next week', 'week', '2026-11-16', '2026-11-22', true)]],
  ['no later than 20.11', [day('20.11', '2026-11-20', true)]],
  ['until Monday', [day('Monday', '2026-11-16', true)]],
  ['innen fredag', [day('fredag', '2026-11-13', true)]],
  ['før 20. november', [day('20. november', '2026-11-20', true)]],
  ['senest på mandag', [day('mandag', '2026-11-16', true)]],
  ['til torsdag', [day('torsdag', '2026-11-19', true)]],
  ['by tomorrow at 3pm', [datetime('tomorrow at 3pm', '2026-11-13', '15:00', true)]],
  ['Deadline: 20.11', [day('20.11', '2026-11-20', true)]],
  ['on Friday', [day('Friday', '2026-11-13')]],
  // ranges
  ['mandag til fredag', [{ phrase: 'mandag til fredag', precision: 'range', window: { start: '2026-11-16', end: '2026-11-20' }, deadline: false }]],
  ['20.11-22.11', [{ phrase: '20.11-22.11', precision: 'range', window: { start: '2026-11-20', end: '2026-11-22' }, deadline: false }]],
  // case-insensitive
  ['TOMORROW', [day('TOMORROW', '2026-11-13')]],
  ['I MORGEN', [day('I MORGEN', '2026-11-13')]],
]

for (const [text, expected] of cases) {
  test(`parses ${JSON.stringify(text)}`, () => {
    const hits = parseTimeExpressions(text, oslo)
    assert.deepEqual(hits.map(pick), expected)
    for (const hit of hits) assert.equal(text.slice(hit.from, hit.to), hit.phrase)
  })
}

test('multiple expressions are returned sorted by offset', () => {
  const text = 'Send it by Friday and review i morgen kl 10, then 20.11.'
  const hits = parseTimeExpressions(text, oslo)
  assert.deepEqual(hits.map((hit) => hit.phrase), ['Friday', 'i morgen kl 10', '20.11'])
  assert.deepEqual(hits.map((hit) => hit.deadline), [true, false, false])
  assert.deepEqual(hits.map((hit) => hit.from), [...hits.map((hit) => hit.from)].sort((a, b) => a - b))
})

const nonMatches = [
  'Version 1.2 is out', 'Upgrade to v1.2.3 now', 'It costs 12.50 kr', 'The ratio is 3.5 hours', 'Mayday mayday', 'We may 5 people', 'A Thursdays-only club',
  'monkey business', 'Sundial and Monday1', 'todayish', 'The word tomorrowland', 'Fri-yay', 'I am free', 'Room 12/34', 'ratio 3:30 wins', 'Norwegian wood', 'Meet at the station',
  'Call 555 1234', 'Point 99.99', '2026-13-45', '31. februar', 'in a hurry', 'om og om igjen', 'Step 1.2.3 done',
]
for (const text of nonMatches) {
  test(`ignores ${JSON.stringify(text)}`, () => {
    assert.deepEqual(parseTimeExpressions(text, oslo).map(pick), [])
  })
}

test('timezone rollover uses the local calendar date', () => {
  const late = { now: new Date('2026-11-12T23:30:00.000Z'), timeZone: 'Europe/Oslo' }
  assert.equal(parseTimeExpressions('today', late)[0].date, '2026-11-13')
  assert.equal(parseTimeExpressions('i morgen', late)[0].date, '2026-11-14')
  assert.equal(parseTimeExpressions('today', { ...late, timeZone: 'UTC' })[0].date, '2026-11-12')
  assert.equal(parseTimeExpressions('today', { now: late.now })[0].date, '2026-11-12')
  const clocks = { now: new Date('2026-03-29T23:30:00.000Z'), timeZone: 'Europe/Oslo' }
  assert.equal(parseTimeExpressions('tomorrow', clocks)[0].date, '2026-03-31')
  assert.deepEqual(pick(parseTimeExpressions('in 90 minutes', late)[0]), datetime('in 90 minutes', '2026-11-13', '02:00'))
})

test('dates without a year resolve to the next occurrence and years roll over', () => {
  const december = { now: new Date('2026-12-28T12:00:00.000Z'), timeZone: 'Europe/Oslo' }
  assert.equal(parseTimeExpressions('5. januar', december)[0].date, '2027-01-05')
  assert.equal(parseTimeExpressions('20.11', december)[0].date, '2027-11-20')
  assert.equal(parseTimeExpressions('28. desember', december)[0].date, '2026-12-28')
  assert.equal(parseTimeExpressions('27. desember', december)[0].date, '2027-12-27')
  assert.equal(parseTimeExpressions('20.11.2026', december)[0].date, '2026-11-20')
  assert.deepEqual(parseTimeExpressions('next week', december).map((hit) => hit.window), [{ start: '2027-01-04', end: '2027-01-10' }])
  assert.deepEqual(parseTimeExpressions('neste måned', december).map((hit) => hit.window), [{ start: '2027-01-01', end: '2027-01-31' }])
})

test('week windows are Monday to Sunday even when today is Sunday', () => {
  const sunday = { now: new Date('2026-11-15T12:00:00.000Z'), timeZone: 'Europe/Oslo' }
  assert.deepEqual(parseTimeExpressions('this week', sunday)[0].window, { start: '2026-11-09', end: '2026-11-15' })
  assert.deepEqual(parseTimeExpressions('next week', sunday)[0].window, { start: '2026-11-16', end: '2026-11-22' })
  assert.deepEqual(parseTimeExpressions('this weekend', sunday)[0].window, { start: '2026-11-15', end: '2026-11-15' })
  assert.deepEqual(parseTimeExpressions('end of week', sunday)[0].window, { start: '2026-11-15', end: '2026-11-15' })
})

test('performance sanity: a 2,000 word note parses in well under 50 ms', () => {
  const text = 'Met Anna on Friday at 10 and send the budget by 20.11. Ring Ola i morgen kl 14. Nothing else happened here. '.repeat(100)
  parseTimeExpressions(text, oslo)
  const started = performance.now()
  parseTimeExpressions(text, oslo)
  assert.ok(performance.now() - started < 50)
})
