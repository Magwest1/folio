// Production wrappers that turn the MLX service into the `generate` and `embed` functions extractActions expects.
const SIMILARITY_PREFIX = 'task: sentence similarity | query: '

/** Deterministic generation (temperature 0 unless overridden) with a small token budget. */
export function mlxGenerate(mlxService, { modelId = undefined } = {}) {
  return (messages, { maxTokens = 96, temperature = 0 } = {}) => mlxService.generate(messages, { maxTokens, temperature, ...(modelId ? { modelId } : {}) })
}

/** Sentence embeddings as plain vectors. */
export function mlxEmbed(mlxService) {
  return async (texts) => {
    const response = await mlxService.embed(texts.map((text) => `${SIMILARITY_PREFIX}${text}`))
    if (!Array.isArray(response?.embeddings) || response.embeddings.length !== texts.length) throw new Error('The embedding model returned an unexpected result.')
    return response.embeddings
  }
}
