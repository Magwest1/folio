// Checks every model-supplied field against the candidate span. The model may only copy; whatever it cannot
// prove from the span is cleared (person, time) or rejects the item (summary).
import { parseTimeExpressions } from '../../knowledge/date-expressions.js'

const FOLD = { å: 'a', ø: 'o', æ: 'a', ä: 'a', ö: 'o', ü: 'u', é: 'e', è: 'e', ê: 'e', á: 'a', à: 'a', í: 'i', ó: 'o', ú: 'u', ñ: 'n', ç: 'c', ß: 's', '’': "'" }

/** Lower-cases and maps Norwegian and accented letters to plain ones, one character for one character. */
export function fold(text) {
  const lower = String(text).normalize('NFC').toLocaleLowerCase()
  return Array.from(lower, (char) => FOLD[char] ?? char).join('')
}

const isWordChar = (char) => char !== undefined && /[\p{L}\p{N}_]/u.test(char)

/** Index of `needle` in `haystack` at word boundaries (folded, case-insensitive), or -1. */
export function findWord(haystack, needle) {
  const source = fold(haystack)
  const target = fold(needle).trim()
  // Offsets only map back to the original text when folding kept every character one-to-one.
  if (!target || source.length !== haystack.length) return -1
  for (let index = source.indexOf(target); index >= 0; index = source.indexOf(target, index + 1)) {
    if (!isWordChar(source[index - 1]) && !isWordChar(source[index + target.length])) return index
  }
  return -1
}

/** The span's own spelling of `person` when it occurs in the span, otherwise null. */
export function groundPerson(person, spanText) {
  if (!person) return null
  const index = findWord(spanText, person)
  return index < 0 ? null : spanText.slice(index, index + person.trim().length)
}

export function dueOf(hit) {
  if (!hit) return null
  if (hit.window?.start && hit.window?.end) return { window: { start: hit.window.start, end: hit.window.end } }
  if (hit.date) return hit.time ? { date: hit.date, time: hit.time } : { date: hit.date }
  return null
}

/**
 * Resolves `phrase` through the date parser against the span. Returns `{ due, from, to }` with absolute
 * offsets, or null when the phrase is missing from the span or the parser cannot resolve it.
 */
export function groundTime(phrase, span, { now, timeZone }) {
  if (!phrase) return null
  const found = findWord(span.text, phrase)
  if (found < 0) return null
  const end = found + phrase.trim().length
  const hits = parseTimeExpressions(span.text, { now, timeZone }).filter((hit) => hit.from < end && hit.to > found && dueOf(hit))
  if (!hits.length) return null
  const hit = hits.find((candidate) => candidate.deadline) ?? hits.find((candidate) => candidate.date || candidate.window) ?? hits[0]
  return { due: dueOf(hit), from: span.from + hit.from, to: span.from + hit.to }
}

const CAPITALISED = /(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{N}'’-]*/gu
const NUMBERS = /\d+/g

/** Problems with a summary: names and digits it introduces that the span does not contain. */
export function summaryProblems(summary, spanText) {
  const problems = []
  const folded = fold(spanText)
  const words = [...summary.matchAll(CAPITALISED)].filter((match) => match.index > 0 && !/[.!?:]\s*$/.test(summary.slice(0, match.index)))
  for (const [word] of words) {
    if (findWord(spanText, word.replace(/['’]s$/u, '')) < 0) problems.push(`name:${word}`)
  }
  for (const [digits] of summary.matchAll(NUMBERS)) {
    if (!folded.includes(digits)) problems.push(`number:${digits}`)
  }
  return problems
}

/**
 * Grounds a parsed model answer. Returns `{ person, timeHit, summary, rejected, issues }`: `person` is the
 * span's spelling or null; `timeHit` is `{ due, from, to }` or null; `rejected` is true when the summary
 * invents names or numbers (the item must be dropped). `issues` lists every failure for `groundingIssues`.
 */
export function groundOutput(output, span, { now, timeZone }) {
  const issues = []
  let person = null
  if (output.person) {
    person = groundPerson(output.person, span.text)
    if (!person) issues.push(`person-not-in-span:${output.person}`)
  }
  let timeHit = null
  if (output.timePhrase) {
    timeHit = groundTime(output.timePhrase, span, { now, timeZone })
    if (!timeHit) issues.push(`time-unresolvable:${output.timePhrase}`)
  }
  const problems = output.isAction ? summaryProblems(output.summary, span.text) : []
  for (const problem of problems) issues.push(`summary-${problem}`)
  return { person, timeHit, summary: output.summary, rejected: problems.length > 0, issues }
}
