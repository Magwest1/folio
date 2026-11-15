// Semantic related-note suggestions, computed from stored embeddings.

const SUGGESTION_THRESHOLD = 0.75
const SUGGESTION_LIMIT = 3

function vectorNorm(vector) {
  let magnitude = 0
  for (let index = 0; index < vector.length; index += 1) magnitude += vector[index] ** 2
  return Math.sqrt(magnitude)
}

// Same arithmetic as cosineSimilarity with the norms hoisted out, so scores are bit-identical.
function cachedCosine(left, leftNorm, right, rightNorm) {
  if (!left?.length || left.length !== right?.length) return 0
  if (!leftNorm || !rightNorm) return 0
  let dot = 0
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index]
  return dot / (leftNorm * rightNorm)
}

// Snapshot of what incremental suggestion updates need to know about a previous index.
function semanticSuggestionState(records) {
  return new Map(records.map((record) => [record.id, {
    embedding: record.embedding || null,
    embeddingInputHash: record.embeddingInputHash || null,
    relatedIds: record.relatedIds || [],
    suggestedRelatedIds: record.suggestedRelatedIds || [],
  }]))
}

function topSuggestions(scored) {
  return scored
    .filter((candidate) => candidate.score >= SUGGESTION_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, SUGGESTION_LIMIT)
    .map((candidate) => candidate.id)
}

// Exact: results equal scoring every record against every other. With `previousState` (from
// semanticSuggestionState of the prior index) only records touched by a change are recomputed in full.
function updateSemanticSuggestions(records, previousState = null) {
  const norms = new Map()
  const indexById = new Map()
  records.forEach((record, index) => {
    indexById.set(record.id, index)
    if (record.embedding) norms.set(record, vectorNorm(record.embedding))
  })
  const score = (record, candidate) => cachedCosine(record.embedding, norms.get(record), candidate.embedding, norms.get(candidate))

  const dirtyIds = new Set()
  if (previousState) {
    for (const record of records) {
      const previous = previousState.get(record.id)
      if (!previous || previous.embedding !== (record.embedding || null)
        || (record.embedding && previous.embeddingInputHash !== record.embeddingInputHash)) dirtyIds.add(record.id)
    }
  }
  const dirtyCandidates = records.filter((record) => dirtyIds.has(record.id) && record.embedding)

  const computeFull = (record, linked) => {
    const scored = []
    records.forEach((candidate, index) => {
      if (candidate === record || candidate.id === record.id || !candidate.embedding || linked.has(candidate.id)) return
      scored.push({ id: candidate.id, index, score: score(record, candidate) })
    })
    return topSuggestions(scored)
  }

  for (const record of records) {
    if (!record.embedding) {
      record.suggestedRelatedIds = []
      continue
    }
    const linked = new Set(record.relatedIds || [])
    const previous = previousState?.get(record.id)
    let incremental = Boolean(previous) && !dirtyIds.has(record.id)
    if (incremental) {
      // A removed link can make a never-suggested note newly eligible, so it needs a full pass.
      if (previous.relatedIds.some((id) => !linked.has(id))) incremental = false
      for (const id of previous.suggestedRelatedIds) {
        const target = records[indexById.get(id)]
        if (!target || !target.embedding || dirtyIds.has(id) || linked.has(id)) incremental = false
      }
    }
    if (!incremental) {
      record.suggestedRelatedIds = computeFull(record, linked)
      continue
    }
    const candidateIds = new Set(previous.suggestedRelatedIds)
    for (const candidate of dirtyCandidates) candidateIds.add(candidate.id)
    candidateIds.delete(record.id)
    const scored = []
    for (const id of candidateIds) {
      const index = indexById.get(id)
      const candidate = records[index]
      if (!candidate?.embedding || linked.has(id)) continue
      scored.push({ id, index, score: score(record, candidate) })
    }
    record.suggestedRelatedIds = topSuggestions(scored)
  }
}

export { semanticSuggestionState, updateSemanticSuggestions }
