import assert from 'node:assert/strict'
import test from 'node:test'

import { extractActions } from '../server/actions/extraction/pipeline.js'
import { scoreStage } from '../scripts/lib/action-eval.js'
import { itemsToPredictions, routingMetrics } from '../scripts/lib/action-eval-model.js'

// The model stage itself needs MLX and never runs here; these tests cover its mapping and metrics with a fake generate.
const caseItem = {
  id: 'fake-001', language: 'en', source: 'note', now: '2026-11-12T09:30:00+01:00', timeZone: 'Europe/Oslo',
  content: '- [ ] Send invoice to Harper by Friday\nRemember to renew the passport.\nPay the electricity bill',
  expected: [
    { quote: '- [ ] Send invoice to Harper by Friday', kind: 'task', person: 'Harper', due: { date: '2026-11-13' }, explicit: true },
    { quote: 'Remember to renew the passport.', kind: 'task', person: null, due: null, explicit: false },
  ],
}
const replies = {
  'Send invoice to Harper by Friday': { is_action: true, actor: 'me', summary: 'Send invoice to Harper', person: 'Harper', time_phrase: 'Friday' },
  'Remember to renew the passport.': { is_action: true, actor: 'me', summary: 'Renew the passport', person: null, time_phrase: null },
  'Pay the electricity bill': { is_action: true, actor: 'me', summary: 'Pay the bill', person: null, time_phrase: null },
}
const generate = async (messages) => ({ text: JSON.stringify(replies[messages.at(-1).content.match(/<sentence>([\s\S]*?)<\/sentence>/)[1]]), modelId: 'fake' })

test('items map to detector-shaped predictions that the existing scorer understands', async () => {
  const records = []
  const predict = async (item) => {
    const { items, stats } = await extractActions({ content: item.content, now: new Date(item.now), timeZone: item.timeZone, generate, options: { maxExtraCalls: 0 } })
    const predictions = itemsToPredictions(items)
    records.push({ caseItem: item, predictions, stats })
    return predictions
  }
  const metrics = await scoreStage([caseItem], predict)
  const [auto, suggested, extra] = records[0].predictions
  assert.equal(auto.explicit, true, 'only status open + origin auto counts as explicit')
  assert.equal(suggested.explicit, false)
  assert.equal(auto.kindHint, 'task')
  assert.equal(auto.person, 'Harper')
  assert.deepEqual(auto.time, { date: '2026-11-13' })
  assert.equal(auto.text, 'Send invoice to Harper by Friday')
  assert.ok(extra)
  assert.equal(metrics.overall.tp, 2)
  assert.equal(metrics.overall.fp, 1)
  assert.equal(metrics.fieldAccuracy.due.accuracy, 1)
  assert.equal(metrics.fieldAccuracy.person.accuracy, 1)
  assert.equal(metrics.explicitPrecision.precision, 1)

  const routing = routingMetrics(records)
  assert.equal(routing.autoPrecision, 1)
  assert.equal(routing.autoRecall, 1)
  assert.equal(routing.suggestionPrecision, 0.5)
  assert.equal(routing.suggestionRecall, 1)
  assert.equal(routing.modelCallsPerCase, 3)
  assert.ok(routing.meanLatencyMs >= 0)
  assert.deepEqual(routing.dropReasons, {})
})

test('routing metrics count drop reasons and demoted explicit actions', () => {
  const stats = { modelCalls: 2, extraCalls: 1, degraded: [{}], dropReasons: { timeout: 1, 'low-confidence': 2 }, timing: { totalMs: 50 } }
  const suggestedOnly = [{ from: 0, to: caseItem.expected[0].quote.length, explicit: false }]
  const routing = routingMetrics([{ caseItem, predictions: suggestedOnly, stats }])
  assert.equal(routing.autoPrecision, null)
  assert.equal(routing.autoRecall, 0)
  assert.equal(routing.suggestionPrecision, 1)
  assert.equal(routing.suggestionRecall, 0, 'the match was for an explicit action, so it does not count as a surfaced non-explicit one')
  assert.equal(routing.degraded, 1)
  assert.deepEqual(Object.keys(routing.dropReasons), ['low-confidence', 'timeout'])
})
