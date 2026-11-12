#!/usr/bin/env node
// Per-stage evaluation report for action extraction (issue #18).
// Usage: node scripts/eval-actions.js [--stage detector] [--cases path | --holdout] [--baseline path]
//   [--write-baseline] [--fail-on-regression] [--json] [--case id] [--verbose]
//   [--model-id id] [--prompt-version v]

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { baselinePathFor, compareToBaseline, createBaseline, defaultCasesPath, holdoutCasesPath, loadBaseline, loadCases, scoreStage, stages, validateCases } from './lib/action-eval.js'

const { values: options } = parseArgs({
  options: {
    stage: { type: 'string', default: 'detector' },
    cases: { type: 'string', default: defaultCasesPath },
    baseline: { type: 'string' },
    'write-baseline': { type: 'boolean', default: false },
    'fail-on-regression': { type: 'boolean', default: false },
    holdout: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    case: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    'model-id': { type: 'string' },
    'prompt-version': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

const pct = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%`.padStart(6) : '   n/a')
const signed = (delta) => `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`
const count = (entry) => `tp ${entry.tp} fp ${entry.fp} fn ${entry.fn}`
const out = (line = '') => process.stdout.write(`${line}\n`)
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1) }

if (options.help) {
  out('node scripts/eval-actions.js [--stage detector|model|completion] [--cases path] [--baseline path] [--write-baseline] [--fail-on-regression] [--json] [--case id] [--verbose] [--model-id id] [--prompt-version v]')
  process.exit(0)
}

const casesPath = options.holdout ? holdoutCasesPath : options.cases
const isHoldout = path.resolve(casesPath) === holdoutCasesPath
const stage = stages[options.stage]
if (!stage) fail(`Unknown stage "${options.stage}". Available: ${Object.keys(stages).join(', ')}.`)

const allCases = await loadCases(casesPath)
const problems = validateCases(allCases)
if (problems.length) {
  process.stderr.write(`Dataset has ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
  process.exit(1)
}
const cases = options.case ? allCases.filter((item) => item.id === options.case) : allCases
if (!cases.length) fail(`No case with id "${options.case}".`)

let predict
try {
  predict = await stage.load()
} catch (error) {
  fail(error.message)
}
const metrics = await scoreStage(cases, predict)

const baselinePath = options.baseline ?? baselinePathFor(options.stage, { holdout: isHoldout })
const baseline = await loadBaseline(baselinePath)
const comparison = baseline && !options.case ? compareToBaseline(metrics, baseline) : null
const regressions = comparison?.filter((entry) => entry.status === 'regression') ?? []

if (options['write-baseline']) {
  if (options.case) fail('Refusing to write a baseline from a single case.')
  await fs.writeFile(baselinePath, `${JSON.stringify(createBaseline(options.stage, metrics, { modelId: options['model-id'], promptVersion: options['prompt-version'] }), null, 2)}\n`)
}

if (options.json) {
  out(JSON.stringify({ stage: options.stage, metrics, comparison }, null, 2))
} else {
  const sections = { language: new Map(), source: new Map() }
  for (const item of cases) for (const key of Object.keys(sections)) sections[key].set(item[key], (sections[key].get(item[key]) ?? 0) + 1)
  const list = (map) => [...map].map(([key, value]) => `${key} ${value}`).join(', ')
  out(`Action evaluation, stage: ${options.stage} (${stage.description})`)
  out(`Dataset name: ${path.basename(casesPath)}${isHoldout ? ' (blind held-out set)' : ''}`)
  out(`Dataset: ${metrics.cases} cases, ${metrics.expected} expected actions, ${cases.filter((item) => item.expected.length === 0).length} pure negatives`)
  out(`  by language: ${list(sections.language)}; by source: ${list(sections.source)}`)
  out(`Predictions: ${metrics.predictions} in ${metrics.elapsedMs} ms`)
  out()
  out('Detection (span overlap)')
  out(`  precision ${pct(metrics.overall.precision)}  recall ${pct(metrics.overall.recall)}  F1 ${pct(metrics.overall.f1)}   ${count(metrics.overall)}`)
  out(`  explicit precision ${pct(metrics.explicitPrecision.precision)}   (${metrics.explicitPrecision.correct}/${metrics.explicitPrecision.predicted} explicit predictions are explicit in the reference; the auto-add bar)`)
  out('Completions (kindHint completion vs case.completions, for #21)')
  out(`  precision ${pct(metrics.completions.precision)}  recall ${pct(metrics.completions.recall)}  F1 ${pct(metrics.completions.f1)}   ${count(metrics.completions)}`)
  out('Field accuracy over matched pairs')
  for (const [field, entry] of Object.entries(metrics.fieldAccuracy)) out(`  ${field.padEnd(9)} ${pct(entry.accuracy)}   (${entry.correct}/${entry.total})`)
  out('By language')
  for (const [key, entry] of Object.entries(metrics.byLanguage)) out(`  ${key.padEnd(6)} P ${pct(entry.precision)}  R ${pct(entry.recall)}  ${count(entry)}`)
  const worst = Object.entries(metrics.byTag)
    .map(([tag, entry]) => ({ tag, entry, errors: entry.fp + entry.fn }))
    .filter((item) => item.errors > 0)
    .sort((left, right) => right.errors - left.errors || left.tag.localeCompare(right.tag))
    .slice(0, 6)
  out('Worst tags (by errors)')
  if (!worst.length) out('  none')
  for (const { tag, entry } of worst) out(`  ${tag.padEnd(20)} ${count(entry)}  (${entry.cases} cases)`)

  if (options.verbose || options.case) {
    out()
    out('Errors')
    for (const detail of metrics.details) {
      for (const prediction of detail.falsePositives) out(`  FP ${detail.id}  ${JSON.stringify(prediction.text)}${prediction.explicit ? ' [explicit]' : ''}`)
      for (const missed of detail.falseNegatives) out(`  FN ${detail.id}  ${JSON.stringify(missed.quote)} (${missed.kind})`)
      for (const prediction of detail.completionFalsePositives) out(`  CFP ${detail.id}  ${JSON.stringify(prediction.text)}`)
      for (const missed of detail.completionFalseNegatives) out(`  CFN ${detail.id}  ${JSON.stringify(missed.quote)}`)
      for (const mismatch of detail.fieldMismatches) out(`  ~~ ${detail.id}  ${mismatch.field}: expected ${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.actual)}  ${JSON.stringify(mismatch.quote)}`)
    }
  }

  out()
  if (options.case) out('Baseline comparison skipped (single case).')
  else if (!comparison) out(`No baseline at ${path.relative(process.cwd(), baselinePath)}; run with --write-baseline to create one.`)
  else {
    out(`Versus baseline ${path.relative(process.cwd(), baselinePath)} (${baseline.date ?? 'undated'}${baseline.modelId ? `, model ${baseline.modelId}` : ''}${baseline.promptVersion ? `, prompt ${baseline.promptVersion}` : ''})`)
    const changed = comparison.filter((entry) => entry.status !== 'unchanged')
    if (!changed.length) out('  no metric moved by more than 2pp')
    for (const entry of changed) out(`  ${entry.status === 'regression' ? 'REGRESSION ' : 'improvement '} ${entry.metric.padEnd(34)} ${pct(entry.baseline)} -> ${pct(entry.current)}  (${signed(entry.delta)})`)
  }
  if (options['write-baseline']) out(`Baseline written to ${path.relative(process.cwd(), baselinePath)}`)
}

if (options['fail-on-regression'] && regressions.length) {
  process.stderr.write(`${regressions.length} metric(s) regressed by more than 2pp.\n`)
  process.exit(1)
}
