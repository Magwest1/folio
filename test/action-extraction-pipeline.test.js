import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTOR_AGREEMENT, computeConfidence, sampleAgreement } from '../server/actions/extraction/confidence.js'
import { deriveKind } from '../server/actions/extraction/kind.js'
import { AUTO_THRESHOLD, PROMPT_VERSION, SUGGEST_THRESHOLD, extractActions } from '../server/actions/extraction/pipeline.js'
import { NON_ACTION_PROTOTYPES } from '../server/actions/extraction/prototypes.js'

const NOW = new Date('2026-11-12T09:30:00+01:00')
const answer = (extra = {}) => JSON.stringify({ is_action: true, actor: 'me', summary: 'Do the thing', person: null, time_phrase: null, ...extra })
const sentenceOf = (messages) => messages.at(-1).content.match(/<sentence>([\s\S]*?)<\/sentence>/)[1]

// Scripted fake model: `script` maps a sentence to a JSON string, an array (one entry per call), a function, or an Error.
function fakeModel(script) {
  const calls = []
  const generate = async (messages, options) => {
    const sentence = sentenceOf(messages)
    calls.push({ sentence, options })
    let entry = script[sentence]
    if (Array.isArray(entry)) entry = entry[Math.min(calls.filter((call) => call.sentence === sentence).length - 1, entry.length - 1)]
    if (typeof entry === 'function') entry = await entry(options)
    if (entry instanceof Error) throw entry
    if (entry === undefined) throw new Error(`unscripted sentence: ${sentence}`)
    return { text: entry, modelId: 'fake-model' }
  }
  return { generate, calls }
}

const run = (content, script, extra = {}) => {
  const model = fakeModel(script)
  return extractActions({ content, now: NOW, timeZone: 'Europe/Oslo', generate: model.generate, ...extra }).then((result) => ({ ...result, model }))
}

const CHECKBOX = '- [ ] Send invoice to Harper by Friday'
const CHECKBOX_SPAN = 'Send invoice to Harper by Friday'

test('thresholds are ordered and the confidence formula is documented behaviour', () => {
  assert.ok(SUGGEST_THRESHOLD < AUTO_THRESHOLD && AUTO_THRESHOLD <= 1)
  assert.match(PROMPT_VERSION, /^extract-v\d+$/)
  assert.equal(computeConfidence({ detector: 1, model: 1, explicit: true }), 1)
  assert.equal(computeConfidence({ detector: 0.5, model: 1, explicit: false }), 0.7)
  assert.equal(computeConfidence({ detector: 0.5, model: 0, explicit: false, issues: 2 }), 0.1)
  assert.equal(computeConfidence({ detector: 0, model: 0, explicit: false, issues: 3 }), 0)
  assert.equal(sampleAgreement({ isAction: false, actor: 'me' }), 0)
  assert.equal(sampleAgreement({ isAction: true, actor: 'other' }), ACTOR_AGREEMENT.other)
  assert.equal(sampleAgreement({ isAction: true, actor: 'me' }, 0), 0.5)
})

test('deriveKind combines the actor with the detector hint and signals', () => {
  assert.equal(deriveKind({ actor: 'other', kindHint: 'waiting-on', signals: ['waiting'] }), 'waiting-on')
  assert.equal(deriveKind({ actor: 'other', kindHint: 'task', signals: ['request-to-other'] }), 'waiting-on')
  assert.equal(deriveKind({ actor: 'other', kindHint: 'task', signals: ['imperative'] }), null)
  assert.equal(deriveKind({ actor: 'me', kindHint: 'follow-up', signals: ['follow-up'] }), 'follow-up')
  assert.equal(deriveKind({ actor: 'me', kindHint: 'event', signals: ['event'] }), 'event')
  assert.equal(deriveKind({ actor: 'me', kindHint: 'my-commitment', signals: [] }), 'my-commitment')
  assert.equal(deriveKind({ actor: 'we', kindHint: 'my-commitment', signals: [] }), 'task')
  assert.equal(deriveKind({ actor: 'unknown', kindHint: null, signals: ['mention'] }), 'task')
})

test('an explicit, grounded first-person action is added automatically with the store item shape', async () => {
  const { items, dropped, stats } = await run(CHECKBOX, { [CHECKBOX_SPAN]: answer({ summary: 'Send invoice to Harper', person: 'Harper', time_phrase: 'Friday' }) })
  assert.equal(dropped.length, 0)
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.status, 'open')
  assert.equal(item.origin, 'auto')
  assert.equal(item.kind, 'task')
  assert.equal(item.text, 'Send invoice to Harper')
  assert.equal(item.person, 'Harper')
  assert.deepEqual(item.due, { date: '2026-11-13' })
  assert.equal(item.explicit, true)
  assert.ok(item.confidence >= AUTO_THRESHOLD)
  assert.deepEqual(item.anchor, { from: 6, to: 38, quote: CHECKBOX_SPAN })
  assert.equal(item.promptVersion, PROMPT_VERSION)
  assert.equal(item.modelId, 'fake-model')
  assert.ok(item.signals.includes('checkbox'))
  assert.deepEqual(stats.dropReasons, {})
  assert.equal(stats.candidates, 1)
  assert.equal(stats.modelCalls, 1)
  assert.equal(stats.extraCalls, 0)
  assert.ok(stats.timing.totalMs >= 0)
})

test('non-explicit actions are suggested, and hopeless ones are dropped with a reason', async () => {
  const content = 'Waiting for Elena to send the signed contract.\nRemember to renew the passport.\nPay the electricity bill'
  const { items, dropped, stats } = await run(content, {
    'Waiting for Elena to send the signed contract.': answer({ actor: 'other', summary: 'Wait for Elena to send the contract', person: 'Elena' }),
    'Remember to renew the passport.': [answer({ summary: 'Renew the passport' })],
    'Pay the electricity bill': answer({ is_action: false, summary: '' }),
  })
  assert.deepEqual(items.map((item) => [item.kind, item.status, item.origin]), [['waiting-on', 'suggested', 'suggested'], ['task', 'suggested', 'suggested']])
  assert.equal(items[0].person, 'Elena')
  assert.deepEqual(dropped.map((entry) => entry.reason), ['model-not-action'])
  assert.equal(dropped[0].quote, 'Pay the electricity bill')
  assert.equal(stats.dropReasons['model-not-action'], 1)
})

test('a failed grounding check clears the field and blocks auto-add', async () => {
  const { items } = await run(CHECKBOX, { [CHECKBOX_SPAN]: answer({ summary: 'Send invoice', person: 'Marcus', time_phrase: 'next month' }) })
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'suggested')
  assert.equal(items[0].person, 'Harper', 'falls back to the detector person that occurs in the span')
  assert.deepEqual(items[0].due, { date: '2026-11-13' }, 'falls back to the detector date')
  assert.deepEqual(items[0].groundingIssues, ['person-not-in-span:Marcus', 'time-unresolvable:next month'])
})

test('a summary that invents names or numbers is replaced by the span text and can never be auto-added', async () => {
  const { items } = await run(CHECKBOX, { [CHECKBOX_SPAN]: answer({ summary: 'Pay 500 kr to Marcus' }) })
  assert.equal(items.length, 1)
  assert.equal(items[0].text, CHECKBOX_SPAN)
  assert.equal(items[0].origin, 'suggested')
  assert.deepEqual(items[0].groundingIssues, ['summary-name:Marcus', 'summary-number:500'])
})

test('an empty summary falls back to the cleaned span text', async () => {
  const { items } = await run('- [ ] Renew the parking permit', { 'Renew the parking permit': answer({ summary: '' }) })
  assert.equal(items[0].text, 'Renew the parking permit')
  assert.equal(items[0].origin, 'auto')
})

test('a time phrase is parsed by the date parser, and one that disagrees with the detector wins', async () => {
  const { items } = await run(CHECKBOX, { [CHECKBOX_SPAN]: answer({ summary: 'Send invoice to Harper', time_phrase: 'by Friday' }) })
  assert.equal(items[0].origin, 'auto', 'a phrase that resolves to the same date agrees')
  const other = await run('- [ ] Send invoice on 3 December or Friday', { 'Send invoice on 3 December or Friday': answer({ summary: 'Send invoice', time_phrase: '3 December' }) })
  assert.deepEqual(other.items[0].due, { date: '2026-12-03' })
})

test('bad JSON and timeouts degrade explicit candidates to suggestions and drop the rest', async () => {
  const content = `${CHECKBOX}\nPay the electricity bill\nRemember to renew the passport.`
  const { items, dropped, stats, model } = await run(content, {
    [CHECKBOX_SPAN]: 'I could not decide, sorry',
    'Pay the electricity bill': () => new Promise(() => {}),
    'Remember to renew the passport.': new Error('worker crashed'),
  }, { options: { timeoutMs: 30 } })
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'suggested')
  assert.equal(items[0].origin, 'suggested')
  assert.equal(items[0].kind, 'task')
  assert.ok(items[0].signals.includes('model-failed:bad-json'))
  assert.deepEqual(dropped.map((entry) => entry.reason), ['timeout', 'model-error'])
  assert.deepEqual(stats.degraded.map((entry) => entry.reason), ['bad-json', 'timeout', 'model-error'])
  assert.ok(!items.some((item) => item.origin === 'auto'))
  assert.equal(model.calls.filter((call) => call.sentence === CHECKBOX_SPAN).length, 2, 'bad JSON gets one warmer retry')
  assert.equal(stats.extraCalls, 1)
})

test('a garbled first answer is rescued by the retry', async () => {
  const { items } = await run(CHECKBOX, { [CHECKBOX_SPAN]: ['{"is_action":true,"personiline"', answer({ summary: 'Send invoice to Harper', person: 'Harper', time_phrase: 'Friday' })] })
  assert.equal(items.length, 1)
  assert.equal(items[0].origin, 'suggested', 'a rescued answer is not unanimous, so it is never auto-added')
})

test('self-consistency: borderline spans get up to two extra samples, bounded per note', async () => {
  const content = 'Remember to renew the passport.\nBook the room\nPay the electricity bill'
  const yes = (summary, actor = 'we') => answer({ summary, actor })
  const script = {
    'Remember to renew the passport.': [answer({ is_action: false, summary: '' }), yes('Renew the passport', 'me'), yes('Renew the passport', 'me')],
    'Book the room': [yes('Book the room'), yes('Book the room'), yes('Book the room')],
    'Pay the electricity bill': [yes('Pay the bill'), yes('Pay the bill'), yes('Pay the bill')],
  }
  const { items, stats, model } = await run(content, script)
  assert.equal(stats.modelCalls, 3)
  assert.equal(stats.extraCalls, 4, 'default budget of four extra calls per note')
  assert.equal(model.calls.length, 7)
  assert.equal(model.calls.filter((call) => call.options.temperature === 0.4).length, 4)
  assert.ok(model.calls.every((call) => call.options.maxTokens > 0))
  assert.equal(items.length, 3)
  const passport = items.find((item) => item.anchor.quote === 'Remember to renew the passport.')
  assert.ok(passport, 'the majority vote overturns the first sample')
  assert.ok(passport.signals.includes('votes:2/3'))
  assert.ok(passport.confidence < 0.85)

  const limited = await run(content, script, { options: { maxExtraCalls: 0 } })
  assert.equal(limited.stats.extraCalls, 0)
  assert.equal(limited.model.calls.length, 3)
  assert.deepEqual(limited.dropped.map((entry) => entry.quote), ['Remember to renew the passport.'])
})

test('confident, agreeing spans take no extra samples', async () => {
  const { stats } = await run('Book the room', { 'Book the room': answer({ summary: 'Book the room' }) })
  assert.equal(stats.extraCalls, 0)
})

test('a failing extra sample does not fail the item', async () => {
  const { items, stats } = await run('Book the room', { 'Book the room': [answer({ summary: 'Book the room', actor: 'we' }), new Error('boom'), 'nonsense'] })
  assert.equal(stats.extraCalls, 2)
  assert.equal(items.length, 1)
  assert.equal(stats.degraded.length, 0)
})

test('kinds are derived deterministically from actor and detector signals', async () => {
  const content = [
    'Waiting for Elena to send the signed contract.',
    'Follow up with Lena about the budget.',
    'Lunch with Sam tomorrow at 12:30.',
    'Jeg skal ringe Kari på mandag.',
    'Remember to renew the passport.',
  ].join('\n')
  const { items } = await run(content, {
    'Waiting for Elena to send the signed contract.': answer({ actor: 'other', summary: 'Wait for the contract', person: 'Elena' }),
    'Follow up with Lena about the budget.': answer({ summary: 'Follow up with Lena', person: 'Lena' }),
    'Lunch with Sam tomorrow at 12:30.': answer({ summary: 'Have lunch with Sam', person: 'Sam', time_phrase: 'tomorrow at 12:30' }),
    'Jeg skal ringe Kari på mandag.': answer({ summary: 'Ring Kari', person: 'Kari', time_phrase: 'mandag' }),
    'Remember to renew the passport.': answer({ summary: 'Renew the passport' }),
  })
  assert.deepEqual(items.map((item) => item.kind), ['waiting-on', 'follow-up', 'event', 'my-commitment', 'task'])
  assert.deepEqual(items[2].due, { date: '2026-11-13', time: '12:30' })
})

test('someone else\'s task is dropped', async () => {
  const { items, dropped } = await run('Pay the electricity bill', { 'Pay the electricity bill': answer({ actor: 'other', summary: 'Pay the electricity bill' }) })
  assert.equal(items.length, 0)
  assert.equal(dropped[0].reason, 'other-persons-task')
})

test('Norwegian spans are extracted and grounded with Norwegian letters', async () => {
  const content = 'Jeg skal ringe Åse på mandag.'
  const { items, model } = await run(content, { 'Jeg skal ringe Åse på mandag.': answer({ summary: 'Ring Åse', person: 'åse', time_phrase: 'mandag' }) })
  assert.match(model.calls[0].sentence, /Åse/)
  assert.equal(items.length, 1)
  assert.equal(items[0].person, 'Åse', 'uses the span spelling')
  assert.deepEqual(items[0].due, { date: '2026-11-16' })
  assert.equal(items[0].origin, 'auto')
})

test('completion candidates never reach the model', async () => {
  const { items, stats, model } = await run('I sent the proposal to Marcus.', {})
  assert.equal(items.length, 0)
  assert.equal(stats.modelCalls, 0)
  assert.equal(model.calls.length, 0)
})

test('the embedding filter drops clear non-actions but never explicit candidates', async () => {
  const content = `${CHECKBOX}\nBook the room\nPay the electricity bill`
  const nonActions = new Set([CHECKBOX_SPAN, 'Book the room'])
  const embedded = []
  const embed = async (texts) => { embedded.push(...texts); return texts.map((text) => (nonActions.has(text) || NON_ACTION_PROTOTYPES.includes(text) ? [0, 1] : [1, 0])) }
  const script = { [CHECKBOX_SPAN]: answer({ summary: 'Send invoice to Harper' }), 'Pay the electricity bill': answer({ summary: 'Pay the bill' }) }
  const { items, dropped, stats, model } = await run(content, script, { embed })
  assert.ok(!embedded.includes(CHECKBOX_SPAN), 'explicit candidates are not even compared')
  assert.deepEqual(dropped.map((entry) => [entry.quote, entry.reason]), [['Book the room', 'embedding-non-action']])
  assert.equal(stats.embeddingDropped, 1)
  assert.equal(items.length, 2)
  assert.ok(!model.calls.some((call) => call.sentence === 'Book the room'))

  const off = await run(content, { ...script, 'Book the room': answer({ summary: 'Book the room' }) }, { embed, options: { embeddingFilter: false } })
  assert.equal(off.stats.embeddingDropped, 0)
  assert.equal(off.items.length, 3)
})

test('an embedding failure leaves every candidate in place', async () => {
  const { items, stats } = await run('Book the room', { 'Book the room': answer({ summary: 'Book the room' }) }, { embed: async () => { throw new Error('no embedding model') } })
  assert.equal(items.length, 1)
  assert.equal(stats.embeddingError, 'no embedding model')
})

test('the prompt carries one sentence of context and treats the note as data', async () => {
  const seen = []
  const generate = async (messages) => { seen.push(messages); return { text: answer({ summary: 'Book the room' }) } }
  await extractActions({ content: 'Offsite planning is on. We agreed.\nBook the room\nThe venue is small. Parking is limited.', now: NOW, timeZone: 'UTC', generate })
  const user = seen[0].at(-1).content
  assert.match(user, /<before>We agreed\.<\/before>/)
  assert.match(user, /<after>The venue is small\.<\/after>/)
})
