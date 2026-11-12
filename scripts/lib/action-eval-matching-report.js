// Command line report for the matching stage (issue #21): `node scripts/eval-actions.js --stage matching`.
import fs from 'node:fs/promises'
import path from 'node:path'

import { compareToBaseline, createBaseline, loadBaseline } from './action-eval.js'
import { loadMatchingCases, matchingBaselinePath, matchingCasesPath, matchingHoldoutPath, scoreMatching, validateMatchingCases } from './action-eval-matching.js'

/** Auto-completions must be right at least this often: a wrong one is undoable but still a surprise. */
export const AUTO_PRECISION_TARGET = 0.97

const pct = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%`.padStart(6) : '   n/a')
const signed = (delta) => `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`
const out = (line = '') => process.stdout.write(`${line}\n`)

/** Runs the stage and prints the report. Resolves to the process exit code. */
export async function runMatchingReport(options, stage) {
  const holdout = options.holdout
  const casesPath = holdout ? matchingHoldoutPath : (options.cases && path.resolve(options.cases) !== path.resolve(options.defaultCases) ? options.cases : matchingCasesPath)
  const all = await loadMatchingCases(casesPath)
  const problems = validateMatchingCases(all)
  if (problems.length) {
    process.stderr.write(`Dataset has ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
    return 1
  }
  const scenarios = options.case ? all.filter((item) => item.id === options.case) : all
  if (!scenarios.length) { process.stderr.write(`No scenario with id "${options.case}".\n`); return 1 }
  let replay
  try { replay = await stage.load({ model: options.model, modelId: options['model-id'] }) } catch (error) { process.stderr.write(`${error.message}\n`); return 1 }
  const metrics = await scoreMatching(scenarios, replay)
  const summary = replay.summary?.() ?? {}
  await replay.close?.()
  const baselinePath = options.baseline ?? matchingBaselinePath(holdout)
  const baseline = options.model ? null : await loadBaseline(baselinePath)
  const comparison = baseline && !options.case ? compareToBaseline(metrics, baseline) : null
  const regressions = comparison?.filter((entry) => entry.status === 'regression') ?? []
  const { repeats, completions, autoCompletion, wrongResurrections, created } = metrics.matching
  if (options['write-baseline']) {
    if (options.case || options.model) { process.stderr.write('Refusing to write a baseline from a subset of the scenarios or a model run.\n'); return 1 }
    await fs.writeFile(baselinePath, `${JSON.stringify(createBaseline('matching', metrics), null, 2)}\n`)
  }
  if (options.json) { out(JSON.stringify({ stage: 'matching', summary, metrics, comparison }, null, 2)) } else {
    out(`Action evaluation, stage: matching (${stage.description})`)
    out(`Dataset name: ${path.basename(casesPath)}${holdout ? ' (blind held-out set)' : ''}   mode: ${summary.mode}${summary.modelId ? ` (${summary.modelId}, embeddings ${summary.embeddings ? 'on' : 'off'})` : ''}`)
    out(`Dataset: ${metrics.scenarios} scenarios in ${metrics.elapsedMs} ms`)
    out()
    out('Repeats (a later note restates an open commitment)')
    out(`  precision ${pct(repeats.precision)}  recall ${pct(repeats.recall)}   tp ${repeats.tp} fp ${repeats.fp} fn ${repeats.fn}`)
    out('Completions (a later note finishes an open action; auto or suggestion)')
    out(`  precision ${pct(completions.precision)}  recall ${pct(completions.recall)}   tp ${completions.tp} fp ${completions.fp} fn ${completions.fn}`)
    out('Auto-completions (applied without asking, undoable)')
    out(`  precision ${pct(autoCompletion.precision)} (${autoCompletion.correct}/${autoCompletion.predicted}, target ${(AUTO_PRECISION_TARGET * 100).toFixed(0)}%)  recall of clear completions ${pct(autoCompletion.recall)} (${autoCompletion.found}/${autoCompletion.expected})`)
    out(`Wrong resurrections: ${wrongResurrections} (must be 0)    recurring items that became new actions: ${created.found}/${created.expected}`)
    out('By language')
    for (const [key, entry] of Object.entries(metrics.byLanguage)) out(`  ${key.padEnd(6)} ${entry.scenarios} scenarios, ${entry.errors} errors`)
    const worst = Object.entries(metrics.byTag).filter(([, entry]) => entry.errors > 0).sort((left, right) => right[1].errors - left[1].errors).slice(0, 6)
    out('Worst tags (by errors)')
    if (!worst.length) out('  none')
    for (const [tag, entry] of worst) out(`  ${tag.padEnd(22)} ${entry.errors} errors in ${entry.scenarios} scenarios`)
    if (options.verbose || options.case) {
      out()
      out('Errors')
      for (const detail of metrics.details) {
        const { errors } = detail
        for (const item of errors.repeatFalsePositives) out(`  RFP ${detail.id}  ${JSON.stringify(item.text)} -> ${JSON.stringify(item.targets)}`)
        for (const quote of errors.repeatMisses) out(`  RFN ${detail.id}  ${JSON.stringify(quote)}`)
        for (const item of errors.completionFalsePositives) out(`  CFP ${detail.id}  ${item.auto ? '[auto] ' : ''}${JSON.stringify(item.text)}`)
        for (const quote of errors.completionMisses) out(`  CFN ${detail.id}  ${JSON.stringify(quote)}`)
        for (const quote of errors.resurrected) out(`  RESURRECTED ${detail.id}  ${JSON.stringify(quote)}`)
        for (const quote of errors.notCreated) out(`  NOT-CREATED ${detail.id}  ${JSON.stringify(quote)}`)
        for (const text of errors.autoNotExpected) out(`  auto but not expected to be auto: ${detail.id}  ${JSON.stringify(text)}`)
      }
    }
    out()
    if (options.case || options.model) out('Baseline comparison skipped.')
    else if (!comparison) out(`No baseline at ${path.relative(process.cwd(), baselinePath)}; run with --write-baseline to create one.`)
    else {
      out(`Versus baseline ${path.relative(process.cwd(), baselinePath)} (${baseline.date ?? 'undated'})`)
      const changed = comparison.filter((entry) => entry.status !== 'unchanged')
      if (!changed.length) out('  no metric moved by more than 2pp')
      for (const entry of changed) out(`  ${entry.status === 'regression' ? 'REGRESSION ' : 'improvement '} ${entry.metric.padEnd(36)} ${pct(entry.baseline)} -> ${pct(entry.current)}  (${signed(entry.delta)})`)
    }
    if (options['write-baseline']) out(`Baseline written to ${path.relative(process.cwd(), baselinePath)}`)
  }
  const failures = []
  if (regressions.length) failures.push(`${regressions.length} metric(s) regressed by more than 2pp.`)
  if (wrongResurrections > 0) failures.push(`${wrongResurrections} wrong resurrection(s).`)
  if (autoCompletion.precision !== null && autoCompletion.precision < AUTO_PRECISION_TARGET) failures.push(`Auto-completion precision is below ${AUTO_PRECISION_TARGET}.`)
  if (failures.length && options['fail-on-regression']) { process.stderr.write(`${failures.join(' ')}\n`); return 1 }
  return 0
}
