import { normalizePassage } from './fingerprint.js'

export const FUZZY_THRESHOLD = 0.85

function wordsWithOffsets(text) {
  const words = []
  for (const match of String(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    words.push({ word: match[0].toLowerCase(), from: match.index, to: match.index + match[0].length })
  }
  return words
}

function overlap(quoteCounts, quoteSize, windowWords) {
  const remaining = new Map(quoteCounts)
  let shared = 0
  for (const { word } of windowWords) {
    const left = remaining.get(word)
    if (left > 0) { shared += 1; remaining.set(word, left - 1) }
  }
  return shared / Math.max(quoteSize, windowWords.length)
}

// Whitespace- and case-insensitive match. Returns one span, or null when there is none or it is ambiguous.
export function fuzzyLocate(content, quote, threshold = FUZZY_THRESHOLD) {
  const quoteWords = wordsWithOffsets(normalizePassage(quote) || quote).map((item) => item.word)
  if (quoteWords.length < 2) return null
  const counts = new Map()
  for (const word of quoteWords) counts.set(word, (counts.get(word) || 0) + 1)
  const words = wordsWithOffsets(content)
  const size = quoteWords.length
  const candidates = []
  for (let start = 0; start < words.length; start += 1) {
    if (!counts.has(words[start].word)) continue
    for (let length = Math.max(2, size - 2); length <= size + 2 && start + length <= words.length; length += 1) {
      const windowWords = words.slice(start, start + length)
      if (!counts.has(windowWords.at(-1).word)) continue
      const score = overlap(counts, size, windowWords)
      if (score >= threshold) candidates.push({ score, start, end: start + length - 1, length })
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.length - size) - Math.abs(b.length - size) || a.start - b.start)
  const best = candidates[0]
  const rival = candidates.find((item) => item.score >= best.score - 1e-9 && (item.end < best.start || item.start > best.end))
  if (rival) return null
  const from = words[best.start].from
  const to = words[best.end].to
  return { from, to, quote: content.slice(from, to) }
}

// Where does an anchored quote live now? Exact (nearest to the old offset) first, then fuzzy.
export function locateQuote(content, anchor) {
  const { quote, from } = anchor
  if (!quote) return null
  if (content.slice(anchor.from, anchor.to) === quote) return { from: anchor.from, to: anchor.to, quote }
  let best = null
  for (let index = content.indexOf(quote); index !== -1; index = content.indexOf(quote, index + 1)) {
    if (best === null || Math.abs(index - from) < Math.abs(best - from)) best = index
  }
  if (best !== null) return { from: best, to: best + quote.length, quote }
  return fuzzyLocate(content, quote)
}
