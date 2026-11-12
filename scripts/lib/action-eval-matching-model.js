// Model-assisted matching evaluation (issue #21). Local only: it starts the MLX helper, so nothing in `npm test` loads it.
import { extractActions } from '../../server/actions/extraction/pipeline.js'
import { mlxEmbed, mlxGenerate } from '../../server/actions/extraction/mlx-adapters.js'
import { askWith, createVectorCache } from '../../server/actions/matching/apply.js'
import { startMlx } from './action-eval-model.js'
import { replayScenario } from './action-eval-matching.js'

export async function loadMatchingModelStage({ modelId } = {}) {
  const mlx = startMlx()
  const status = await mlx.status()
  const model = (status.models || []).find((item) => item.purpose === 'generation' && (modelId ? item.id === modelId : item.selected) && item.installed)
  if (!model) throw new Error(`No installed generation model${modelId ? ` "${modelId}"` : ''} was found in the model root.`)
  const embeddings = (status.models || []).some((item) => item.purpose === 'embeddings' && item.installed)
  const generate = mlxGenerate(mlx, { modelId: model.id })
  const embed = embeddings ? mlxEmbed(mlx) : null
  const vectors = createVectorCache(embed)
  const extract = async (note, { now, timeZone }) => (await extractActions({
    content: note.content, noteId: note.id, now, timeZone, generate, embed, options: { modelId: model.id },
  })).items
  const replay = (scenario) => replayScenario(scenario, { extract, vectors, ask: askWith(generate) })
  replay.close = () => mlx.close()
  replay.summary = () => ({ mode: 'model', modelId: model.id, embeddings })
  return replay
}
