import crypto from 'node:crypto'

const LINE_MARKER = /^\s*(?:>\s*)*(?:[-*+•]\s+(?:\[[ xX]\]\s*)?|\[[ xX]\]\s+|\d+[.)]\s+)/u

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex')

// Lowercase, strip list/checkbox markers per line, collapse whitespace, trim punctuation.
export function normalizePassage(value) {
  const stripped = String(value ?? '')
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((line) => line.replace(LINE_MARKER, ''))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
  return stripped.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
}

const hashOf = (value) => {
  const normalized = normalizePassage(value)
  return normalized ? sha1(normalized) : null
}

export const quoteKey = hashOf
export const textKey = hashOf

export function fingerprintFor({ quote, text }) {
  return { quoteKey: quoteKey(quote), textKey: textKey(text) }
}
