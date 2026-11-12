import assert from 'node:assert/strict'
import test from 'node:test'

import { CANDIDATE_THRESHOLD, detectActionCandidates } from '../server/actions/detector.js'

// Thursday 2026-11-12 in Oslo.
const options = { now: new Date('2026-11-12T10:00:00.000Z'), timeZone: 'Europe/Oslo' }
const detect = (content) => detectActionCandidates(content, options)

// [text, expected]; expected === null means no candidate.
const cases = [
  // explicit markers
  ['- [ ] Call the bank', { kindHint: 'task', explicit: true, has: ['checkbox'] }],
  ['- [ ] kjøpe melk i morgen', { kindHint: 'task', explicit: true, has: ['checkbox'], time: 'i morgen' }],
  ['TODO: renew passport', { kindHint: 'task', explicit: true, has: ['todo-marker'] }],
  ['todo - renew passport', { kindHint: 'task', explicit: true, has: ['todo-marker'] }],
  ['Gjøremål: kjøpe melk', { kindHint: 'task', explicit: true, has: ['todo-marker'] }],
  ['- [x] Call the bank', { kindHint: 'completion', explicit: false, has: ['checkbox', 'completion'], low: true }],
  ['- [X] Ring banken', { kindHint: 'completion', explicit: false, low: true }],
  // first-person commitments
  ["I'll send the budget to Anna by Friday.", { kindHint: 'my-commitment', explicit: true, person: 'Anna', has: ['first-person-commitment', 'deadline'], time: 'Friday' }],
  ['Jeg skal sende budsjettet til Anna innen fredag.', { kindHint: 'my-commitment', explicit: true, person: 'Anna', has: ['first-person-commitment', 'deadline'], time: 'fredag' }],
  ['I will call the client tomorrow at 3pm.', { kindHint: 'my-commitment', explicit: true, time: 'tomorrow at 3pm' }],
  ['I need to finish the report by tomorrow.', { kindHint: 'task', explicit: true, has: ['first-person-commitment', 'obligation'] }],
  ['Jeg må levere rapporten på fredag.', { kindHint: 'task', explicit: true, has: ['obligation'] }],
  ["I'll send the budget.", { kindHint: 'my-commitment', explicit: false, has: ['first-person-commitment'] }],
  ['Jeg skal ringe banken.', { kindHint: 'my-commitment', explicit: false }],
  ["I'm going to book the flights next week.", { kindHint: 'my-commitment', explicit: true }],
  ["We'll review the plan on Monday.", null],
  // obligations and imperatives
  ['Remember to buy milk.', { kindHint: 'task', explicit: false, has: ['obligation'] }],
  ['Husk å ringe tannlegen.', { kindHint: 'task', has: ['obligation'] }],
  ["Don't forget to submit the form by 20.11.", { kindHint: 'task', has: ['obligation', 'deadline'] }],
  ['The invoice must be paid by Friday.', { kindHint: 'task', has: ['obligation', 'deadline'] }],
  ['Vi må sjekke kontrakten.', null],
  ['We should probably review the plan.', null],
  ['Send the invoice to Acme tomorrow.', { kindHint: 'task', explicit: false, has: ['imperative'], person: 'Acme' }],
  ['Bestill billetter før påske.', { kindHint: 'task', has: ['imperative', 'deadline'] }],
  ['Ring Kari', { kindHint: 'task', has: ['imperative'], person: 'Kari' }],
  ['please review the PR', { kindHint: 'task', has: ['imperative'] }],
  ['@ola please review the PR', { kindHint: 'task', has: ['imperative', 'mention'], person: 'ola' }],
  ['Skriv ut kontrakten og signer den.', { kindHint: 'task', has: ['imperative'] }],
  // waiting and follow-up
  ["Waiting for Anna's reply on the contract.", { kindHint: 'waiting-on', has: ['waiting'], person: 'Anna' }],
  ['Venter på svar fra Ola.', { kindHint: 'waiting-on', has: ['waiting'], person: 'Ola' }],
  ['Anna will send me the report on Monday.', { kindHint: 'waiting-on', has: ['waiting'], person: 'Anna', time: 'Monday' }],
  ['Anna skal sende meg rapporten.', { kindHint: 'waiting-on', has: ['waiting'], person: 'Anna' }],
  ["She said she'll send me the file by Friday.", { kindHint: 'waiting-on', has: ['waiting'] }],
  ['Follow up with Bob next week.', { kindHint: 'follow-up', has: ['follow-up'], person: 'Bob', time: 'next week' }],
  ['Sjekke med Kari om kontrakten.', { kindHint: 'follow-up', has: ['follow-up'], person: 'Kari' }],
  ['Må følge opp leverandøren.', { kindHint: 'follow-up', has: ['follow-up'] }],
  ['Can you send me the slides by Friday?', { kindHint: 'waiting-on', has: ['request-to-other', 'deadline'] }],
  ['Kan du sende meg lysbildene?', { kindHint: 'waiting-on', has: ['request-to-other'] }],
  ['Ask Anna to send the figures.', { kindHint: 'task', has: ['request-to-other'], person: 'Anna' }],
  ['Spør Ola om budsjettet.', { kindHint: 'task', person: 'Ola' }],
  // events
  ['Meeting with Anna on Friday at 10.', { kindHint: 'event', explicit: false, person: 'Anna', time: 'Friday at 10' }],
  ['Møte med Ola i morgen kl 14.', { kindHint: 'event', explicit: false, person: 'Ola', time: 'i morgen kl 14' }],
  ['Lunch with Kari tomorrow.', { kindHint: 'event', person: 'Kari' }],
  ["I'll attend the meeting with Anna on Friday.", { kindHint: 'my-commitment' }],
  // completions
  ['I sent the budget yesterday.', { kindHint: 'completion', explicit: false, low: true }],
  ['I sent the budget to Anna.', { kindHint: 'completion', low: true }],
  ['Jeg sendte budsjettet i går.', { kindHint: 'completion', low: true }],
  ['Jeg har sendt det.', { kindHint: 'completion', low: true }],
  ['Done: booked the hotel.', { kindHint: 'completion', low: true }],
  ['Ferdig med rapporten.', { kindHint: 'completion', low: true }],
  ['The invoice has been paid.', { kindHint: 'completion', low: true }],
  ["I sent the budget, now I'll call Anna tomorrow.", { kindHint: 'my-commitment', has: ['first-person-commitment'] }],
  // negatives
  ["I won't send that.", null],
  ["I won't be sending the budget tomorrow.", null],
  ["We don't need to book a hotel.", null],
  ['Jeg trenger ikke å ringe Anna.', null],
  ['Jeg skal ikke sende noe i morgen.', null],
  ['If we have time we could send it.', null],
  ["Maybe we could call Anna tomorrow.", null],
  ['Kanskje vi kan ringe Anna i morgen?', null],
  ['Hvis vi får tid skal vi sende det.', null],
  ['What if I send the budget on Friday?', null],
  ['Should I send the budget?', null],
  ['Skal jeg sende budsjettet?', null],
  ['Did we call Anna yesterday?', null],
  ['He said "I\'ll send it tomorrow".', null],
  ['«Jeg skal sende det i morgen», sa han.', null],
  ['"Send the budget to Anna by Friday"', null],
  ['`send the budget` is a code sample', null],
  ['The weather is nice today.', null],
  ['Let me know if you need anything.', null],
  ['The meeting notes are in the shared folder.', null],
  ['Version 1.2 shipped.', null],
  ['Mayday is a distress call.', null],
  ['Lunsj var god i dag.', null],

  // person extraction
  ['Meet Dana at the station on Friday.', { person: 'Dana' }],
  ['Noor asked me to proof the flyer, so I will do it today.', { person: 'Noor', kindHint: 'my-commitment' }],
  ['- [ ] pick up a card for Mira', { person: 'Mira' }],
  ['Ringe Siri om nøkkelen.', { person: 'Siri', kindHint: 'task' }],
  ['Venter på at Tor sender tegningene.', { kindHint: 'waiting-on', person: 'Tor' }],
  ['Følge opp Hedda i neste uke.', { kindHint: 'follow-up', person: 'Hedda' }],
  ['Sende planen til Jonas i morgen', { kindHint: 'task', person: 'Jonas' }],
  ['Leif skal sende meg skissen.', { kindHint: 'waiting-on', person: 'Leif' }],
  ['Marit, can you forward me the invoice?', { kindHint: 'waiting-on', person: 'Marit' }],
  // kind
  ['I promised to review the draft for Lena by Friday.', { kindHint: 'my-commitment', explicit: true, person: 'Lena' }],
  ['I said I would call Hugo in three days.', { kindHint: 'my-commitment', person: 'Hugo' }],
  ['Jeg lovet å ringe Eli om to dager.', { kindHint: 'my-commitment', person: 'Eli' }],
  ['Jeg tar over rapporten i morgen.', { kindHint: 'my-commitment', explicit: false }],
  ["I'm also going to email the whole team the notes tomorrow.", { kindHint: 'my-commitment', explicit: true }],
  ["I'll also send everyone the agenda on Monday.", { kindHint: 'my-commitment', explicit: true }],
  ['Jeg skal også sende alle programmet i morgen.', { kindHint: 'my-commitment', explicit: true }],
  ['Husk å fylle bensin.', { kindHint: 'task' }],
  ['Og så må vi snakke med Sander om budsjettet.', { kindHint: 'follow-up', person: 'Sander' }],
  ['We need to talk to Julie about the schedule.', { kindHint: 'follow-up', person: 'Julie' }],
  // leading time labels
  ['tomorrow: submit the form at the desk', { kindHint: 'task', time: 'tomorrow' }],
  ['in 5 days: pay the deposit', { kindHint: 'task', time: 'in 5 days' }],
  ['i morgen: hente pakken til Tine', { kindHint: 'task', time: 'i morgen', person: 'Tine' }],
  ['om fem dager: betale depositum', { kindHint: 'task', time: 'om fem dager' }],
  // events
  ['Dentist appointment Thursday 19 November at 14:30', { kindHint: 'event', explicit: false }],
  ['Optiker fredag 20. november kl. 10.15', { kindHint: 'event', explicit: false }],
  ['Kafé med Ruth i morgen kl 12', { kindHint: 'event' }],
  ['The delivery is in 6 days.', { kindHint: 'event' }],
  ['Rørleggeren kommer om tre dager.', { kindHint: 'event' }],
  ['The bridge was built in 1932.', null],
  ['Boka kom ut i 1987.', null],
  ['I can do that tomorrow afternoon.', null],
  // conditional follow-ups
  ['Nudge him on Tuesday if there is no answer.', { kindHint: 'follow-up' }],
  ['Hvis ikke svaret kommer innen tirsdag, sender jeg en purring.', { kindHint: 'follow-up', explicit: false }],
  // lowercase infinitive captures
  ['hente barna kl 15', { kindHint: 'task' }],
  ['kjøpe blomster til Mona', { kindHint: 'task', person: 'Mona' }],
  // below the threshold
  ['Do we need to renew the licence this month?', null],
  ['Må vi hente bilen på fredag?', null],
  ['Vi skal ikke kjøpe flere stoler før jul.', null],
  ['Maybe we could move the lunch to Tuesday.', null],
  ['Kanskje vi kunne ta en tur til hytta neste helg.', null],
  ['I want to get fitter this year.', null],
  ['I should stretch more.', null],
  ['Jeg burde sove mer.', null],
  ['The doctor said I should drink more water.', null],
  ['Legen sa at jeg bør trene oftere.', null],
  ['Mix the flour and whisk until smooth.', null],
  ['Ha i to dl melk og rør til det er jevnt.', null],
  ['Ravi will repair the printer.', null],
  ['Silje skal hente kunden på flyplassen.', null],
  ['Nora is waiting for the vendor to confirm.', null],
  ['Ingrid venter på svar fra banken.', null],
]

for (const [text, expected] of cases) {
  test(`detects ${JSON.stringify(text)}`, () => {
    const candidates = detect(text)
    if (expected === null) {
      assert.deepEqual(candidates.map(({ text: matched, score, signals }) => ({ matched, score, signals })), [])
      return
    }
    assert.equal(candidates.length, 1, JSON.stringify(candidates))
    const [candidate] = candidates
    const body = text.replace(/^- \[.\] /, '')
    assert.equal(candidate.text, body)
    assert.equal(candidate.from, text.length - body.length)
    assert.equal(candidate.to, text.length)
    assert.ok(candidate.score >= CANDIDATE_THRESHOLD && candidate.score <= 1)
    if ('kindHint' in expected) assert.equal(candidate.kindHint, expected.kindHint)
    if ('explicit' in expected) assert.equal(candidate.explicit, expected.explicit)
    if ('person' in expected) assert.equal(candidate.person, expected.person)
    if ('time' in expected) assert.equal(candidate.time?.phrase, expected.time)
    if (expected.low) assert.ok(candidate.score < 0.4, `score ${candidate.score}`)
    if (expected.maxScore) assert.ok(candidate.score <= expected.maxScore)
    for (const signal of expected.has ?? []) assert.ok(candidate.signals.includes(signal), `${signal} missing in ${candidate.signals}`)
  })
}

test('explicit is reserved for markers and clear first-person commitments with a time', () => {
  const explicit = (text) => detect(text).map((candidate) => candidate.explicit)
  assert.deepEqual(explicit("I'll send it by Friday."), [true])
  assert.deepEqual(explicit("I'll send it."), [false])
  assert.deepEqual(explicit('Send it by Friday.'), [false])
  assert.deepEqual(explicit('Anna will send me the file by Friday.'), [false])
  assert.deepEqual(explicit("I won't send it by Friday."), [])
  assert.deepEqual(explicit('Maybe I will send it by Friday.'), [])
  assert.deepEqual(explicit('**Anna:** I will send it by Friday.'), [false])
})

test('hypothetical or negated first-person commitments are never explicit', () => {
  const lowered = detect('If possible I will send it by Friday, otherwise later if we can.')
  assert.ok(lowered.every((candidate) => candidate.explicit === false))
})

test('multi-line notes report offsets, sorting and times relative to the full content', () => {
  const content = [
    '---', 'title: Weekly', '---', '# Weekly sync', '',
    '- [ ] Book the room for Friday', '- [x] Send the agenda', '',
    '```', 'TODO: ignored in code', '```', '',
    '> Quoted: I will send it tomorrow.', '',
    "I'll email Anna i morgen kl 10. Waiting for Ola. Nothing else.", '',
    'Venter på svar fra Kari innen fredag.',
  ].join('\n')
  const candidates = detect(content)
  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    'Book the room for Friday', 'Send the agenda', "I'll email Anna i morgen kl 10.", 'Waiting for Ola.', 'Venter på svar fra Kari innen fredag.',
  ])
  for (const candidate of candidates) {
    assert.equal(content.slice(candidate.from, candidate.to), candidate.text)
    if (candidate.time) assert.equal(content.slice(candidate.time.from, candidate.time.to), candidate.time.phrase)
  }
  assert.deepEqual(candidates.map((candidate) => candidate.kindHint), ['task', 'completion', 'my-commitment', 'waiting-on', 'waiting-on'])
  assert.equal(candidates[2].time.date, '2026-11-13')
  assert.equal(candidates[2].time.time, '10:00')
  assert.equal(candidates[4].time.deadline, true)
  assert.equal(candidates[0].time.date, '2026-11-13')
  assert.deepEqual(candidates.map((candidate) => candidate.from), [...candidates.map((candidate) => candidate.from)].sort((a, b) => a - b))
})

test('transcripts attribute commitments to the speaker', () => {
  const transcript = [
    '**Anna:** I will send the budget by Friday. The weather is nice.',
    '**Bob:** Can you send me the slides?',
    '[00:42] Ola: Jeg skal ringe kunden i morgen.',
    '', '**{{speaker1}}** [01:00]', 'I need to book the room.',
  ].join('\n')
  const candidates = detect(transcript)
  assert.deepEqual(candidates.map((candidate) => candidate.person), ['Anna', 'Bob', 'Ola', null])
  assert.ok(candidates[0].signals.includes('speaker-commitment'))
  assert.equal(candidates[0].explicit, false)
  assert.equal(candidates[0].kindHint, 'my-commitment')
  assert.equal(candidates[1].kindHint, 'task')
  assert.equal(candidates[3].text, 'I need to book the room.')
  assert.equal(candidates.every((candidate) => !candidate.explicit), true)
})

test('timezone changes the resolved date of a relative time', () => {
  const late = { now: new Date('2026-11-12T23:30:00.000Z'), timeZone: 'Europe/Oslo' }
  const [candidate] = detectActionCandidates("I'll send it tomorrow.", late)
  assert.equal(candidate.time.date, '2026-11-14')
})

test('empty or non-action content yields no candidates', () => {
  assert.deepEqual(detect(''), [])
  assert.deepEqual(detect('# Notes\n\nA calm day with nothing to do.'), [])
})

test('the threshold is exported and scores stay within 0..1', () => {
  assert.equal(CANDIDATE_THRESHOLD, 0.2)
  const stacked = detect("- [ ] TODO: I'll call Anna tomorrow, remember to send it by Friday @anna")
  assert.equal(stacked.length, 1)
  assert.ok(stacked[0].score <= 1 && stacked[0].score > 0.9)
})

test('performance sanity: a 2,000 word note is analysed in well under 50 ms', () => {
  const paragraph = [
    'Met Anna on Friday at 10 about the roadmap.', "I'll send the budget to Anna by Friday.", '- [ ] Call the bank tomorrow.',
    'Jeg skal sende rapporten innen 20.11.', 'Waiting for Ola to reply.', "We don't need to book a hotel e.g. in Oslo.",
    'The weather was fine and we talked about many things for a long while today.',
  ].join('\n')
  const note = `${`${paragraph}\n`.repeat(30)}`
  assert.ok(note.split(/\s+/).length >= 1500)
  detect(note)
  const started = performance.now()
  const candidates = detect(note)
  assert.ok(performance.now() - started < 50)
  assert.ok(candidates.length >= 100)
})
