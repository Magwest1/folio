// Splits note Markdown and meeting transcripts into checkbox, list, heading and sentence segments with
// character offsets into the original content. Code fences, blockquotes and YAML frontmatter are skipped.
// Segmentation is line based: a sentence never spans lines, so rough captures without punctuation work.
const FENCE = /^\s*(`{3,}|~{3,})/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
const TIMESTAMP = /^\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s*/
const NOTE_SPEAKER = /^\s*\*\*\{\{(\w+)\}\}\*\*\s*(?:\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s*)?/
const NAME = '\\p{Lu}[\\p{L}\\p{N}\'’.-]*(?: \\p{Lu}[\\p{L}\\p{N}\'’.-]*){0,2}'
const BOLD_SPEAKER = new RegExp(`^\\s*(?:\\*\\*(${NAME}):\\*\\*|\\*\\*(${NAME})\\*\\*:)\\s*`, 'u')
const PLAIN_SPEAKER = new RegExp(`^\\s*(${NAME}):\\s+(?=\\S)`, 'u')
const NOT_SPEAKERS = new Set([
  'todo', 'to-do', 'to do', 'action', 'actions', 'action item', 'action items', 'note', 'notes', 'merk', 'obs', 'nb', 'fixme',
  'reminder', 'husk', 'deadline', 'frist', 'gjøremål', 'oppgave', 'oppgaver', 'agenda', 'summary', 'sammendrag', 'decision',
  'decisions', 'beslutning', 'beslutninger', 'meeting', 'meeting notes', 'møte', 'møtenotater', 'attendees', 'deltakere',
  'participants', 'date', 'dato', 'time', 'tid', 'location', 'sted', 'subject', 'emne', 'tags', 'status', 'next steps',
  'neste steg', 'waiting', 'venter', 'follow-up', 'follow up', 'important', 'viktig', 'warning', 'tip', 'example', 'eksempel',
  'done', 'ferdig', 'completed', 'finished', 'fullført', 'question', 'spørsmål', 'answer', 'svar', 'context', 'kontekst', 'idea', 'idé', 'problem', 'solution', 'løsning',
])
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'eg', 'ie', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'no', 'nr', 'approx', 'ca', 'cf', 'ref', 'st', 'jr', 'sr',
  'inc', 'ltd', 'co', 'fig', 'tel', 'tlf', 'f.eks', 'bl.a', 'm.a', 'o.l', 'o.a', 'osv', 'dvs', 'kl', 'evt', 'mfl', 'jf', 'pga',
  'ifm', 'mht', 'iht', 'ifb', 'mv', 'mm', 'ev', 'omtr', 'spm', 'sv', 'resp', 'dept', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'okt', 'nov', 'dec', 'des', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
])
const MONTH_START = /^(?:jan|feb|mar|apr|mai|may|jun|jul|aug|sep|okt|oct|nov|des|dec)/i

function isSentenceEnd(text, dotIndex, afterIndex) {
  if (text[dotIndex] !== '.') return true
  const before = text.slice(Math.max(0, dotIndex - 24), dotIndex)
  const token = before.match(/[\p{L}\p{N}.]+$/u)?.[0] ?? ''
  const lowered = token.toLocaleLowerCase()
  if (ABBREVIATIONS.has(lowered)) return false
  if (/^\p{Lu}$/u.test(token)) return false
  if (/^\d{1,2}$/.test(token) && (/^\p{Ll}/u.test(text.slice(afterIndex)) || MONTH_START.test(text.slice(afterIndex)))) return false
  return true
}

function splitSentences(text) {
  const parts = []
  let start = 0
  for (const match of text.matchAll(/([.!?…]+)["'”’)\]»]*(\s+)/gu)) {
    const after = match.index + match[0].length
    if (!/^[\p{L}\p{N}"'“‘([«-]/u.test(text.slice(after, after + 1))) continue
    const dotIndex = match.index + match[1].length - 1
    if (match[1] === '.' && !isSentenceEnd(text, dotIndex, after)) continue
    parts.push([start, after - match[2].length])
    start = after
  }
  parts.push([start, text.length])
  return parts.filter(([from, to]) => to > from)
}

function pushSegment(segments, line, lineStart, from, to, extra) {
  const text = line.slice(from, to).trimEnd()
  const stamp = text.trimStart().match(/^\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s*/)?.[0].length ?? 0
  const lead = text.length - text.trimStart().length + stamp
  const trimmed = text.trimStart().slice(stamp)
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) return
  segments.push({ text: trimmed, from: lineStart + from + lead, to: lineStart + from + lead + trimmed.length, ...extra })
}

function speakerOf(rest, state) {
  const header = rest.match(NOTE_SPEAKER)
  if (header) {
    state.header = header[1]
    return { speaker: header[1], skip: header[0].length }
  }
  const stamp = rest.match(TIMESTAMP)
  const afterStamp = stamp ? stamp[0].length : 0
  const tail = rest.slice(afterStamp)
  const named = tail.match(BOLD_SPEAKER) ?? tail.match(PLAIN_SPEAKER)
  const name = named && (named[1] ?? named[2])
  if (name && !NOT_SPEAKERS.has(name.toLocaleLowerCase())) return { speaker: name, skip: afterStamp + named[0].length }
  if (stamp || state.continues) return { speaker: state.header ?? undefined, skip: afterStamp }
  return { speaker: undefined, skip: 0 }
}

function lineKind(line) {
  const heading = line.match(HEADING)
  if (heading) return { kind: 'heading', from: line.indexOf(heading[1]), to: line.indexOf(heading[1]) + heading[1].length }
  const item = line.match(LIST_ITEM)
  if (item) {
    const from = line.length - item[3].length
    const checked = item[2] === undefined ? undefined : item[2] !== ' '
    return { kind: checked === undefined ? 'list' : 'checkbox', from, to: line.length, checked }
  }
  return null
}

/** Returns `{ text, from, to, kind, checked?, speaker? }` segments in document order. */
export function segmentText(content) {
  const source = String(content)
  const segments = []
  const state = { header: null, continues: false }
  let fence = null
  let inFrontmatter = false
  let blank = false
  let offset = 0
  let lineNumber = 0
  while (offset <= source.length) {
    const newline = source.indexOf('\n', offset)
    const end = newline === -1 ? source.length : newline
    const line = source.slice(offset, end).replace(/\r$/, '')
    const lineStart = offset
    offset = end + 1
    lineNumber += 1
    if (lineNumber === 1 && line.trim() === '---') { inFrontmatter = true; continue }
    if (inFrontmatter) { if (/^(?:---|\.\.\.)\s*$/.test(line)) inFrontmatter = false; continue }
    const fenceMatch = line.match(FENCE)
    if (fence) { if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null; continue }
    if (fenceMatch) { fence = fenceMatch[1]; continue }
    if (!line.trim()) { blank = true; continue }
    if (/^\s*>/.test(line) || RULE.test(line) || /^\s*<!--/.test(line)) continue
    const structural = lineKind(line)
    if (structural) {
      if (structural.kind === 'heading') { state.header = null; state.continues = false }
      pushSegment(segments, line, lineStart, structural.from, structural.to, structural.checked === undefined ? { kind: structural.kind } : { kind: structural.kind, checked: structural.checked })
      blank = false
      continue
    }
    const hasStamp = TIMESTAMP.test(line)
    state.continues = state.header !== null && (!blank || hasStamp)
    const { speaker, skip } = speakerOf(line, state)
    if (!state.continues && !speaker) state.header = null
    blank = false
    const body = line.slice(skip)
    if (!body.trim()) continue
    for (const [from, to] of splitSentences(body)) {
      pushSegment(segments, line, lineStart, skip + from, skip + to, speaker ? { kind: 'sentence', speaker } : { kind: 'sentence' })
    }
  }
  return segments
}
