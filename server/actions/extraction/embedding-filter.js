// Optional pre-filter: drops candidates that sit clearly closer to non-action prototypes than to action ones.
// Explicit candidates are never dropped. Any embedding failure leaves every candidate in place.
import { ACTION_PROTOTYPES, NON_ACTION_PROTOTYPES } from './prototypes.js'

export const EMBEDDING_MARGIN = 0.08

const prototypeCache = new WeakMap()

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

const best = (vector, group) => group.reduce((max, other) => Math.max(max, cosine(vector, other)), -1)

async function prototypeVectors(embed) {
  if (!prototypeCache.has(embed)) {
    prototypeCache.set(embed, embed([...ACTION_PROTOTYPES, ...NON_ACTION_PROTOTYPES]).then((vectors) => ({
      action: vectors.slice(0, ACTION_PROTOTYPES.length),
      other: vectors.slice(ACTION_PROTOTYPES.length),
    })))
    prototypeCache.get(embed).catch(() => prototypeCache.delete(embed))
  }
  return prototypeCache.get(embed)
}

/** Returns `{ kept, dropped: [{ candidate, margin }] }`. */
export async function filterByEmbedding(candidates, embed, margin = EMBEDDING_MARGIN) {
  const checkable = candidates.filter((candidate) => !candidate.explicit)
  if (!checkable.length) return { kept: candidates, dropped: [] }
  const [prototypes, vectors] = await Promise.all([prototypeVectors(embed), embed(checkable.map((candidate) => candidate.text))])
  if (!Array.isArray(vectors) || vectors.length !== checkable.length) throw new Error('The embedding function returned the wrong number of vectors.')
  const dropped = []
  const drop = new Set()
  checkable.forEach((candidate, index) => {
    const gap = best(vectors[index], prototypes.action) - best(vectors[index], prototypes.other)
    if (gap < -margin) { drop.add(candidate); dropped.push({ candidate, margin: Math.round(gap * 1000) / 1000 }) }
  })
  return { kept: candidates.filter((candidate) => !drop.has(candidate)), dropped }
}
