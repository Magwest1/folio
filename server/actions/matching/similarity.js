// Similarity between two short action sentences, with no model: normalised tokens, a light stemmer for English and
// Norwegian, stop words, and Jaccard plus containment over the content words. When sentence embeddings are available
// their cosine is blended in. Person and due-date compatibility are separate, explicit checks so every decision can be
// explained in `reasons`.
import { dueRange } from '../validate.js'
import { PAST_TO_BASE } from './verbs.js'

const FUNCTION_WORDS = [
  // English
  'the', 'a', 'an', 'to', 'of', 'for', 'with', 'on', 'in', 'at', 'by', 'and', 'or', 'my', 'our', 'your', 'his', 'her', 'their', 'i', 'we', 'you',
  'it', 'that', 'this', 'these', 'those', 'please', 'then', 'also', 'about', 'from', 'them', 'him', 'me', 'us', 'need', 'needs', 'needed', 'must',
  'should', 'will', 'would', 'shall', 'can', 'could', 'have', 'has', 'had', 'be', 'been', 'is', 'are', 'was', 'were', 'am', 'remember', 'forget',
  'dont', 'do', 'did', 'just', 'still', 'already', 'finally', 'so', 'as', 'up', 'out', 'over', 'off', 'some', 'any', 'all', 'one', 'if', 'but',
  'todo', 'task', 'action', 'item', 'make', 'sure', 'get', 'got', 'want', 'wanted', 'going', 'gonna', 'll', 've', 'd', 's', 't',
  // Norwegian
  'og', 'å', 'til', 'med', 'på', 'av', 'en', 'et', 'ei', 'det', 'den', 'de', 'jeg', 'vi', 'du', 'meg', 'deg', 'oss', 'som', 'at', 'om', 'har',
  'hadde', 'skal', 'skulle', 'må', 'måtte', 'kan', 'kunne', 'vil', 'ville', 'bør', 'burde', 'er', 'var', 'ble', 'bli', 'være', 'ikke', 'så', 'også',
  'bare', 'fra', 'hos', 'husk', 'glem', 'glemme', 'trenger', 'sørg', 'for', 'min', 'mitt', 'mine', 'vår', 'vårt', 'din', 'ditt', 'hans', 'hennes',
  'seg', 'sin', 'sitt', 'sine', 'dem', 'han', 'hun', 'nå', 'allerede', 'nettopp', 'fortsatt', 'ennå', 'litt', 'noen', 'noe', 'alle', 'alt', 'hva',
  'ha', 'få', 'fikk', 'gjøre', 'får',
]
// Time words belong to the due date, which is compared on its own.
const TIME_WORDS = [
  'today', 'tomorrow', 'yesterday', 'tonight', 'morning', 'afternoon', 'evening', 'week', 'weekend', 'month', 'next', 'last', 'this', 'before',
  'after', 'until', 'later', 'soon', 'asap', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'eod', 'eow', 'noon', 'now',
  'i', 'dag', 'går', 'morgen', 'kveld', 'natt', 'ettermiddag', 'formiddag', 'uke', 'uka', 'helg', 'helgen', 'måned', 'neste', 'forrige', 'innen',
  'før', 'etter', 'senest', 'snart', 'kl', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag', 'januar', 'februar', 'mars',
  'mai', 'juni', 'juli', 'oktober', 'desember', 'overmorgen', 'ila', 'i', 'denne', 'dette',
]
const fold = (value) => String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/ø/g, 'o').replace(/æ/g, 'ae')
export const STOP_WORDS = new Set([...FUNCTION_WORDS, ...TIME_WORDS].map(fold))
// The past-tense table in folded form: keys are lookups, values are base verbs.
const BASE = new Map(Object.entries(PAST_TO_BASE).map(([form, base]) => [fold(form), fold(base)]))

const SUFFIXES = ['ings', 'ing', 'ere', 'ene', 'ane', 'ede', 'ets', 'er', 'es', 'en', 'et', 'ed', 'ly', 's', 'a', 'e']

/** Light stemmer: base-form lookup for irregular and past forms, then one common suffix off words of five letters or more. */
export function stem(word) {
  const folded = fold(word)
  let value = BASE.get(folded) ?? folded
  if (value.length >= 5) {
    for (const suffix of SUFFIXES) {
      if (value.endsWith(suffix) && value.length - suffix.length >= 3) { value = value.slice(0, -suffix.length); break }
    }
  }
  return value
}

/** Folded, stemmed content words of `text`; stop words and `exclude` (for example person names) are dropped. */
export function contentWords(text, exclude = []) {
  const skip = new Set(exclude.map((word) => fold(word)))
  const source = fold(String(text ?? '').replace(/^[\s>*_~-]*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/, '')).replace(/e-mail/g, 'email').replace(/['’]/g, '')
  const words = []
  for (const token of source.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length < 2 || STOP_WORDS.has(token) || skip.has(token) || /^\d{1,2}$/.test(token)) continue
    const root = stem(token)
    if (!STOP_WORDS.has(root)) words.push(root)
  }
  return [...new Set(words)]
}

// "Same commitment" compares the two sentences symmetrically; "completion" checks how much of the open action the
// finished sentence covers, because a report of completion often adds words ("all sorted", "yesterday").
export const WEIGHTS = {
  repeat: { jaccard: 0.6, other: 0.4 },
  completion: { jaccard: 0.15, other: 0.85 },
}

/**
 * Lexical similarity of `left` (the new sentence) to `right` (the existing action). Fewer than two shared content words
 * is capped as a weak match unless one side has a single content word (for example "Call Kari" with the name removed).
 */
export function lexicalSimilarity(left, right, { exclude = [], role = 'repeat' } = {}) {
  const a = new Set(contentWords(left, exclude))
  const b = new Set(contentWords(right, exclude))
  const shared = [...a].filter((word) => b.has(word)).length
  const result = { score: 0, shared, jaccard: 0, containment: 0, coverage: 0, sizes: [a.size, b.size] }
  if (!a.size || !b.size || !shared) return result
  result.jaccard = shared / (a.size + b.size - shared)
  result.containment = shared / Math.min(a.size, b.size)
  result.coverage = shared / b.size
  const weights = WEIGHTS[role]
  const score = weights.jaccard * result.jaccard + weights.other * (role === 'completion' ? result.coverage : result.containment)
  result.score = shared < 2 && Math.min(a.size, b.size) > 1 ? Math.min(0.3, score) : score
  return result
}

export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return null
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null
}

// EmbeddingGemma similarity cosines of paraphrases sit around 0.75-0.9 and unrelated task sentences below 0.5.
export const COSINE_FLOOR = 0.55
export const COSINE_SPAN = 0.4
export const EMBEDDING_WEIGHT = 0.45
export const semanticScore = (value) => Math.max(0, Math.min(1, (value - COSINE_FLOOR) / COSINE_SPAN))

/**
 * Combined text score in [0, 1]. `embeddings` is an optional Map of text -> vector. Without vectors the score is the
 * lexical one and `mode` is 'lexical' (callers apply stricter thresholds); with vectors it is
 * max(lexical, (1 - EMBEDDING_WEIGHT) * lexical + EMBEDDING_WEIGHT * semantic). A pair that shares no content word is
 * capped, so embeddings alone never create a match.
 */
export function textSimilarity(left, right, { embeddings = null, exclude = [], role = 'repeat' } = {}) {
  const lexical = lexicalSimilarity(left, right, { exclude, role })
  const base = { lexical: lexical.score, shared: lexical.shared, sizes: lexical.sizes }
  const cos = embeddings ? cosine(embeddings.get(left), embeddings.get(right)) : null
  if (cos === null) return { ...base, score: lexical.score, cosine: null, mode: 'lexical' }
  const blended = (1 - EMBEDDING_WEIGHT) * lexical.score + EMBEDDING_WEIGHT * semanticScore(cos)
  // Embeddings only add evidence: a weak cosine never lowers a strong lexical match.
  return { ...base, score: lexical.shared ? Math.max(lexical.score, blended) : Math.min(blended, 0.4), cosine: cos, mode: 'embedding' }
}

// ---------------------------------------------------------------- people

const nameParts = (value) => fold(value).replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean)

/**
 * 'same' | 'different' | 'none' (neither side names anyone) | 'unknown' (only one side does). Case and diacritic
 * insensitive; first names decide.
 */
export function comparePeople(left, right) {
  const a = nameParts(left)
  const b = nameParts(right)
  if (!a.length && !b.length) return 'none'
  if (!a.length || !b.length) return 'unknown'
  if (a[0] !== b[0]) return 'different'
  return a.length > 1 && b.length > 1 && a.at(-1) !== b.at(-1) ? 'different' : 'same'
}

/** Whether `text` names `person` (their first name as a word). The detector often misses the name in a past-tense sentence. */
export function mentionsPerson(text, person) {
  const first = nameParts(person)[0]
  return Boolean(first) && (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).includes(first)
}

// ---------------------------------------------------------------- due dates

/** 'equal' | 'overlap' | 'unknown' (one side undated) | 'conflict'. */
export function compareDue(left, right) {
  const a = dueRange(left)
  const b = dueRange(right)
  if (!a || !b) return 'unknown'
  if (a.start === b.start && a.end === b.end) return 'equal'
  return a.start <= b.end && b.start <= a.end ? 'overlap' : 'conflict'
}
