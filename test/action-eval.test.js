import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { baselinePathFor, compareToBaseline, createBaseline, defaultCasesPath, holdoutCasesPath, loadBaseline, loadCases, matchPredictions, scoreStage, stages, validateCases } from '../scripts/lib/action-eval.js'

const tiny = {
  id: 'tiny',
  language: 'en',
  source: 'note',
  now: '2026-11-12T09:30:00+01:00',
  timeZone: 'Europe/Oslo',
  content: 'Intro line.\n- [ ] Send invoice to Harper by Friday\nI sent the report. Waiting for Elena.',
  expected: [
    { quote: '- [ ] Send invoice to Harper by Friday', kind: 'task', person: 'Harper', due: { date: '2026-11-13' }, explicit: true },
    { quote: 'Waiting for Elena.', kind: 'waiting-on', person: 'Elena', due: null, explicit: false },
  ],
  tags: ['checkbox'],
}
const spanOf = (quote) => ({ from: tiny.content.indexOf(quote), to: tiny.content.indexOf(quote) + quote.length })

test('the reference dataset is valid', async () => {
  const cases = await loadCases(defaultCasesPath)
  assert.deepEqual(validateCases(cases), [])
  assert.ok(cases.length >= 60)
  assert.deepEqual(validateCases(await loadCases(holdoutCasesPath)), [], 'held-out set')
  const languages = new Set(cases.map((item) => item.language))
  assert.ok(languages.has('en') && languages.has('no'))
})

test('validateCases reports bad quotes, duplicate ids and malformed fields', () => {
  const broken = [
    { ...tiny, expected: [{ ...tiny.expected[0], quote: 'not in the content' }] },
    { ...tiny, expected: [{ ...tiny.expected[0], quote: 'I', kind: 'chore', due: { date: '2026-02-30' } }] },
    { ...tiny, id: 'window', expected: [{ ...tiny.expected[0], due: { window: { start: '2026-11-20', end: '2026-11-10' } } }], completions: [{ quote: 'missing' }] },
  ]
  const problems = validateCases(broken).join('\n')
  assert.match(problems, /tiny: expected\[0\]\.quote must appear exactly once in content \(found 0\)/)
  assert.match(problems, /duplicate id/)
  assert.match(problems, /kind must be one of/)
  assert.match(problems, /valid YYYY-MM-DD/)
  assert.match(problems, /window start is after its end/)
  assert.match(problems, /completions\[0\]/)
  assert.deepEqual(validateCases([tiny]), [])
})

test('matchPredictions pairs by overlap, one-to-one', () => {
  const invoice = spanOf('- [ ] Send invoice to Harper by Friday')
  const partial = { from: invoice.from - 5, to: invoice.from + 10 }
  const waiting = spanOf('Waiting for Elena.')
  const stray = spanOf('I sent the report.')
  const result = matchPredictions(tiny, [partial, invoice, waiting, stray])
  assert.equal(result.truePositives.length, 2)
  assert.equal(result.truePositives[0].prediction, invoice, 'the larger overlap is matched first')
  assert.deepEqual(result.falsePositives, [partial, stray], 'a second overlapping prediction is a false positive')
  assert.equal(result.falseNegatives.length, 0)

  const none = matchPredictions(tiny, [])
  assert.equal(none.falseNegatives.length, 2)
  const adjacent = matchPredictions(tiny, [{ from: spanOf('Waiting for Elena.').to, to: spanOf('Waiting for Elena.').to + 1 }])
  assert.equal(adjacent.truePositives.length, 0, 'touching spans do not overlap')
})

test('scoreStage computes precision, recall, field accuracy and explicit precision', async () => {
  const predictions = [
    { ...spanOf('- [ ] Send invoice to Harper by Friday'), explicit: true, kindHint: 'task', person: 'harper', time: { date: '2026-11-13', precision: 'day' } },
    { ...spanOf('Waiting for Elena.'), explicit: true, kindHint: 'follow-up', person: 'Elena', time: null },
    { ...spanOf('I sent the report.'), explicit: false, kindHint: null, person: null, time: null },
  ]
  const metrics = await scoreStage([tiny], async () => predictions)
  assert.equal(metrics.overall.tp, 2)
  assert.equal(metrics.overall.fp, 1)
  assert.equal(metrics.overall.fn, 0)
  assert.equal(metrics.overall.precision, 2 / 3)
  assert.equal(metrics.overall.recall, 1)
  assert.equal(metrics.fieldAccuracy.kind.accuracy, 0.5)
  assert.equal(metrics.fieldAccuracy.person.accuracy, 1)
  assert.equal(metrics.fieldAccuracy.due.accuracy, 1)
  assert.equal(metrics.fieldAccuracy.explicit.accuracy, 0.5)
  assert.deepEqual(metrics.explicitPrecision, { predicted: 2, correct: 1, precision: 0.5 })
  assert.equal(metrics.byLanguage.en.tp, 2)
  assert.equal(metrics.byTag.checkbox.cases, 1)
  assert.equal(metrics.details[0].falsePositives[0].text, 'I sent the report.')
})

test('scoreStage scores completion candidates separately from actions', async () => {
  const done = { ...tiny, id: 'done', content: 'I sent the report. Call Ola.', expected: [{ quote: 'Call Ola.', kind: 'task', person: 'Ola', due: null, explicit: false }], completions: [{ quote: 'I sent the report.' }, { quote: 'Call Ola.' }] }
  const at = (quote) => ({ from: done.content.indexOf(quote), to: done.content.indexOf(quote) + quote.length })
  const metrics = await scoreStage([done], () => [
    { ...at('I sent the report.'), kindHint: 'completion', explicit: false },
    { ...at('Call Ola.'), kindHint: 'task', explicit: false },
  ])
  assert.equal(metrics.overall.fp, 0, 'completions are not action false positives')
  assert.equal(metrics.overall.tp, 1)
  assert.deepEqual([metrics.completions.tp, metrics.completions.fp, metrics.completions.fn], [1, 0, 1])
  assert.equal(metrics.completions.recall, 0.5)
  assert.ok(compareToBaseline(metrics, createBaseline('detector', metrics)).some((entry) => entry.metric === 'completions.recall'))
})

test('scoreStage compares due values exactly, including windows and times', async () => {
  const windowCase = {
    ...tiny,
    id: 'window',
    content: 'Follow up next week. Dinner at 19:00 tomorrow.',
    expected: [
      { quote: 'Follow up next week.', kind: 'follow-up', person: null, due: { window: { start: '2026-11-16', end: '2026-11-22' } }, explicit: false },
      { quote: 'Dinner at 19:00 tomorrow.', kind: 'event', person: null, due: { date: '2026-11-13', time: '19:00' }, explicit: false },
    ],
  }
  const at = (quote) => ({ from: windowCase.content.indexOf(quote), to: windowCase.content.indexOf(quote) + quote.length, kindHint: null, explicit: false })
  const good = await scoreStage([windowCase], () => [
    { ...at('Follow up next week.'), time: { window: { start: '2026-11-16', end: '2026-11-22' }, precision: 'week' } },
    { ...at('Dinner at 19:00 tomorrow.'), time: { date: '2026-11-13', time: '19:00', precision: 'datetime' } },
  ])
  assert.equal(good.fieldAccuracy.due.accuracy, 1)
  const bad = await scoreStage([windowCase], () => [
    { ...at('Follow up next week.'), time: { window: { start: '2026-11-16', end: '2026-11-23' }, precision: 'week' } },
    { ...at('Dinner at 19:00 tomorrow.'), time: { date: '2026-11-13', precision: 'day' } },
  ])
  assert.equal(bad.fieldAccuracy.due.accuracy, 0)
})

test('compareToBaseline reports regressions and improvements beyond the tolerance', async () => {
  const perfect = [{ ...spanOf('- [ ] Send invoice to Harper by Friday'), explicit: true }, { ...spanOf('Waiting for Elena.'), explicit: false }]
  const good = await scoreStage([tiny], () => perfect)
  const worse = await scoreStage([tiny], () => perfect.slice(0, 1))
  const baseline = createBaseline('detector', good, { date: '2026-11-12T00:00:00.000Z', promptVersion: 'v1' })
  assert.equal(baseline.promptVersion, 'v1')
  assert.equal(baseline.details, undefined)
  assert.equal(baseline.metrics.details, undefined)

  const same = compareToBaseline(good, baseline)
  assert.ok(same.length > 0 && same.every((entry) => entry.status === 'unchanged' && entry.delta === 0))

  const regressed = compareToBaseline(worse, baseline).find((entry) => entry.metric === 'overall.recall')
  assert.equal(regressed.status, 'regression')
  assert.equal(regressed.delta, -0.5)

  const improved = compareToBaseline(good, createBaseline('detector', worse)).find((entry) => entry.metric === 'overall.recall')
  assert.equal(improved.status, 'improvement')

  const small = compareToBaseline({ ...good, overall: { ...good.overall, recall: 0.99 } }, baseline).find((entry) => entry.metric === 'overall.recall')
  assert.equal(small.status, 'unchanged', 'drops within the tolerance are not regressions')
})

test('unfinished stages fail with a clear message', async () => {
  await assert.rejects(stages.model.load(), /not implemented yet \(see #17\)/)
  await assert.rejects(stages.completion.load(), /not implemented yet \(see #21\)/)
})

const gated = new Set(['overall.recall', 'overall.precision', 'explicitPrecision.precision'])

for (const [label, holdout, casesPath] of [['main set', false, defaultCasesPath], ['held-out set', true, holdoutCasesPath]]) {
  test(`detector stage does not regress against its baseline (${label})`, async (t) => {
    if (!stages.detector.available()) return t.skip('server/actions/detector.js does not exist yet')
    const baseline = await loadBaseline(baselinePathFor('detector', { holdout }))
    if (!baseline) return t.skip(`no baseline-detector${holdout ? '-holdout' : ''}.json yet; run \`npm run eval:actions -- ${holdout ? '--holdout ' : ''}--write-baseline\``)
    const metrics = await scoreStage(await loadCases(casesPath), await stages.detector.load())
    const comparison = compareToBaseline(metrics, baseline).filter((entry) => gated.has(entry.metric))
    assert.equal(comparison.length, gated.size, 'the baseline must contain the gated metrics')
    assert.deepEqual(comparison.filter((entry) => entry.status === 'regression'), [], 'detector regressed against the baseline (run npm run eval:actions -- --verbose)')
  })
}

test('baseline path follows the stage name', () => {
  assert.ok(baselinePathFor('detector').endsWith('test/fixtures/action-eval/baseline-detector.json'))
  assert.ok(existsSync(defaultCasesPath))
})
