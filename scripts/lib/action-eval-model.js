// Model stage of the action evaluation (issue #17). Local only: it needs the MLX helper and installed models,
// so nothing in `npm test` loads it. The pure parts (prediction mapping, routing metrics) are unit tested.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractActions } from '../../server/actions/extraction/pipeline.js'
import { mlxEmbed, mlxGenerate } from '../../server/actions/extraction/mlx-adapters.js'
import { helperPath } from '../../server/mlx/helper-path.js'
import { createMlxService } from '../../server/mlx/service.js'
import { matchPredictions } from './action-eval.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)

/** Maps pipeline items to detector-shaped predictions so scoreStage works unchanged. */
export function itemsToPredictions(items) {
  return items.map((item) => ({
    from: item.anchor.from,
    to: item.anchor.to,
    text: item.anchor.quote,
    score: item.confidence,
    signals: item.signals,
    kindHint: item.kind,
    person: item.person ?? null,
    time: item.due ?? null,
    explicit: item.status === 'open' && item.origin === 'auto',
    routing: item.origin,
  }))
}

/**
 * Routing metrics over `[{ caseItem, predictions, stats }]` records: auto-add precision and recall, suggestion
 * precision and recall, model calls and latency per case, and the histogram of drop reasons.
 */
export function routingMetrics(records) {
  const auto = { predicted: 0, correct: 0, expected: 0, found: 0 }
  const suggested = { predicted: 0, correct: 0, expected: 0, found: 0 }
  const drops = {}
  let calls = 0
  let extra = 0
  let totalMs = 0
  let degraded = 0
  for (const { caseItem, predictions, stats } of records) {
    const match = matchPredictions(caseItem, predictions)
    for (const prediction of predictions) (prediction.explicit ? auto : suggested).predicted += 1
    for (const { expected, prediction } of match.truePositives) {
      if (prediction.explicit && expected.explicit) auto.correct += 1
      if (!prediction.explicit) suggested.correct += 1
    }
    for (const expected of caseItem.expected) {
      const hit = match.truePositives.find((pair) => pair.expected === expected)
      if (expected.explicit) { auto.expected += 1; if (hit?.prediction.explicit) auto.found += 1 }
      else { suggested.expected += 1; if (hit && !hit.prediction.explicit) suggested.found += 1 }
    }
    calls += stats.modelCalls
    extra += stats.extraCalls
    totalMs += stats.timing.totalMs
    degraded += stats.degraded.length
    for (const [reason, count] of Object.entries(stats.dropReasons)) drops[reason] = (drops[reason] ?? 0) + count
  }
  const cases = records.length
  return {
    autoPrecision: ratio(auto.correct, auto.predicted), autoRecall: ratio(auto.found, auto.expected), auto,
    suggestionPrecision: ratio(suggested.correct, suggested.predicted), suggestionRecall: ratio(suggested.found, suggested.expected), suggested,
    modelCallsPerCase: ratio(calls, cases), extraCallsPerCase: ratio(extra, cases), meanLatencyMs: ratio(totalMs, cases), degraded,
    dropReasons: Object.fromEntries(Object.entries(drops).sort(([, left], [, right]) => right - left)),
  }
}

export function startMlx() {
  const modelRoot = process.env.FOLIO_MODEL_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'Folio', 'models')
  const helper = helperPath(projectRoot)
  if (!existsSync(helper)) {
    throw new Error(`The MLX helper is not built at ${helper}. Run "npm run build:mlx" (needs Xcode) or set FOLIO_MLX_HELPER to a folio-mlx binary.`)
  }
  return createMlxService({ projectRoot, modelRoot, mlxHelperPath: helper })
}

/**
 * Starts MLX and resolves to `predictFn(caseItem)` with `.records`, `.close()` and `.summary()` attached.
 * Options: `embeddingFilter` (default true), `modelId`.
 */
export async function loadModelStage({ embeddingFilter = true, modelId } = {}) {
  const mlx = startMlx()
  const status = await mlx.status()
  const model = (status.models || []).find((item) => item.purpose === 'generation' && (modelId ? item.id === modelId : item.selected) && item.installed)
  if (!model) throw new Error(`No installed generation model${modelId ? ` "${modelId}"` : ''} was found in the model root.`)
  const useEmbeddings = embeddingFilter && (status.models || []).some((item) => item.purpose === 'embeddings' && item.installed)
  const generate = mlxGenerate(mlx, { modelId: model.id })
  const embed = useEmbeddings ? mlxEmbed(mlx) : null
  const records = []
  const predict = async (caseItem) => {
    const { items, dropped, stats } = await extractActions({
      content: caseItem.content, noteId: caseItem.id, now: new Date(caseItem.now), timeZone: caseItem.timeZone, generate, embed,
      options: { embeddingFilter, modelId: model.id },
    })
    const predictions = itemsToPredictions(items)
    records.push({ caseItem, predictions, stats, dropped })
    return predictions
  }
  predict.records = records
  predict.close = () => mlx.close()
  predict.summary = () => ({ modelId: model.id, embeddingFilter: useEmbeddings, routing: routingMetrics(records) })
  return predict
}
