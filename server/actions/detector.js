// Deterministic first pass that finds candidate actions in notes, transcripts and rough captures. It scores
// segments with English and Norwegian rule tables (see lexicon.js) so a model only sees short candidate spans.
import { dateKeyInZone, parseTimeExpressions } from '../knowledge/date-expressions.js'
import * as lexicon from './lexicon.js'
import { segmentText } from './segments.js'

export const CANDIDATE_THRESHOLD = 0.2

const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|`[^`\n]*`/gu
const blank = (match) => ' '.repeat(match.length)
const WEIGHTS = {
  checkbox: 0.95, 'todo-marker': 0.9, imperative: 0.45, mention: 0.15, deadline: 0.22, waiting: 0.6,
  'request-to-other': 0.5, 'follow-up': 0.45, 'speaker-commitment': 0.1,
}
const upperFirst = (word) => /^\p{Lu}/u.test(word)

function maskSegment(text) {
  return text.replace(/’/g, "'").replace(QUOTED, blank)
}

function validName(raw) {
  if (!raw) return null
  const words = raw.trim().split(/\s+/)
  const name = []
  for (const word of words) {
    if (!upperFirst(word) || lexicon.NAME_STOP.has(word.toLocaleLowerCase())) break
    name.push(word.replace(/['’]s$/u, '').replace(/['’-]+$/u, ''))
  }
  return name.length ? name.join(' ') : null
}

function personOf(text, extras) {
  const mention = text.match(lexicon.MENTION)
  if (mention) return mention[1]
  const vocative = validName(text.match(lexicon.VOCATIVE)?.[1])
  if (vocative) return vocative
  if (extras.waitingPerson) return extras.waitingPerson
  for (const match of text.matchAll(lexicon.PERSON_AFTER)) {
    const name = validName(match[1])
    if (name) return name
  }
  return validName(text.match(lexicon.SUBJECT_NAME)?.[1]) ?? extras.speakerPerson ?? null
}

function pickTime(hits) {
  return hits.find((hit) => hit.deadline) ?? hits.find((hit) => hit.date || hit.window) ?? hits[0] ?? null
}

function eventTime(hits) {
  return hits.some((hit) => hit.date || hit.window || hit.time)
}

function firstPersonSignals(text, found) {
  let strong = 0
  for (const [pattern, weight] of lexicon.FIRST_PERSON) {
    if (pattern.test(text)) strong = Math.max(strong, weight)
  }
  const obligation = lexicon.FIRST_PERSON_OBLIGATION.test(text)
  const weak = !obligation && lexicon.FIRST_PERSON_WEAK.test(text)
  if (strong) found.set('first-person-commitment', lexicon.BE_CASUAL.test(text) ? strong * 0.5 : strong)
  else if (obligation) found.set('first-person-commitment', 0.55)
  else if (weak) found.set('first-person-commitment', 0.1)
  if (obligation) found.set('obligation', 0.35)
  return { any: Boolean(strong || obligation || weak), mine: strong >= 0.4 }
}

function obligationSignal(text, found) {
  if (found.has('obligation')) return
  for (const [pattern, weight] of lexicon.OBLIGATION) {
    if (pattern.test(text)) { found.set('obligation', lexicon.WE_OBLIGATION.test(text) ? Math.min(weight, 0.1) : weight); return }
  }
}

function waitingSignals(text, found, extras) {
  const waiting = lexicon.WAITING.exec(text)
  if (waiting && !thirdParty(text.slice(0, waiting.index))) {
    found.set('waiting', WEIGHTS.waiting)
    extras.waitingPerson = validName(text.match(lexicon.WAITING_NAMED)?.[1])
  }
  const will = text.match(lexicon.WILL_DO)
  if (!will || !lexicon.TO_ME.test(will[2]) || !(upperFirst(will[1]) ? validName(will[1]) : lexicon.PRONOUNS.has(will[1].toLocaleLowerCase()))) return
  found.set('waiting', 0.55)
  extras.waitingPerson ??= validName(will[1])
}

function noisyOr(found) {
  let rest = 1
  for (const weight of found.values()) rest *= 1 - weight
  return 1 - rest
}

function kindHintOf(signals, flags) {
  if (flags.completion) return 'completion'
  if (signals.has('waiting')) return 'waiting-on'
  if (signals.has('follow-up')) return 'follow-up'
  if (flags.mine) return 'my-commitment'
  if (['checkbox', 'todo-marker', 'imperative', 'obligation', 'first-person-commitment', 'request-to-other'].some((id) => signals.has(id))) {
    return signals.has('request-to-other') && !flags.speaker && !signals.has('imperative') ? 'waiting-on' : 'task'
  }
  return signals.has('event') ? 'event' : null
}

function thirdParty(before) {
  const subject = before.match(lexicon.THIRD_PARTY_BEFORE)?.[1]
  return Boolean(subject && (validName(subject) || lexicon.PRONOUNS.has(subject.toLocaleLowerCase())))
}

function wordCount(text) {
  return text.trim().split(/\s+/).length
}

function eventSignal(text, hits, found, today) {
  if (lexicon.PAST_STATE.test(text) || /\?\s*$/.test(text)) return
  const dated = eventTime(hits)
  if (lexicon.EVENT.test(text) && (dated || lexicon.EVENT_WITH.test(text))) { found.set('event', dated ? 0.5 : 0.3); return }
  if (noisyOr(found) > 0.1) return
  const future = (hit) => !hit.deadline && (hit.date ?? hit.window?.end) >= today
  if (wordCount(text) <= 9 && !lexicon.FIRST_PERSON_PRONOUN.test(text) && hits.some((hit) => hit.date && hit.time && /\d/.test(hit.phrase) && future(hit))) found.set('event', 0.5)
  else if (hits.some((hit) => /^(?:in|om)\s/i.test(hit.phrase) && future(hit)) && lexicon.EVENT_VERB.test(text)) found.set('event', 0.5)
}

function analyze(segment, text, hits, today) {
  const found = new Map()
  const extras = { speakerPerson: segment.speaker && !/^speaker\d+$/i.test(segment.speaker) ? segment.speaker : null }
  const time = pickTime(hits)
  const heading = segment.kind === 'heading'
  if (segment.kind === 'checkbox' && segment.checked === true) {
    return { found: new Map([['checkbox', 0.3], ['completion', 0.3]]), flags: { completion: true }, time, person: personOf(text, extras), score: 0.3, explicit: false }
  }
  const label = time && time.from === segment.from && text[time.to - segment.from] === ':' ? time.to - segment.from + 1 : 0
  const body = label ? ' '.repeat(label) + text.slice(label) : text
  if (segment.kind === 'checkbox') found.set('checkbox', WEIGHTS.checkbox)
  if (lexicon.TODO_MARKER.test(text)) found.set('todo-marker', WEIGHTS['todo-marker'])
  const firstPerson = firstPersonSignals(text, found)
  obligationSignal(text, found)
  if ((lexicon.IMPERATIVE.test(body) || lexicon.INFINITIVE.test(body)) && !lexicon.COOKING.test(text)) found.set('imperative', WEIGHTS.imperative)
  waitingSignals(text, found, extras)
  const contingent = lexicon.CONTINGENT.test(text)
  if (lexicon.FOLLOW_UP.test(text) || contingent) found.set('follow-up', WEIGHTS['follow-up'])
  if (lexicon.REQUEST.some((pattern) => pattern.test(text))) found.set('request-to-other', WEIGHTS['request-to-other'])
  const actionScore = noisyOr(found)
  const completion = lexicon.COMPLETION.some((pattern) => pattern.test(text)) && actionScore < 0.5 && !lexicon.HISTORY_YEAR.test(text)
  if (!heading) {
    if (lexicon.MENTION.test(text)) found.set('mention', WEIGHTS.mention)
    if (time?.deadline) found.set('deadline', WEIGHTS.deadline)
    eventSignal(text, hits, found, today)
    if (firstPerson.mine && segment.speaker) found.set('speaker-commitment', WEIGHTS['speaker-commitment'])
  }
  let score = noisyOr(found)
  const explicitMarker = found.has('checkbox') || found.has('todo-marker')
  const dampers = []
  if (lexicon.NEGATION.test(text)) dampers.push(['negation', 0.2])
  if (contingent) dampers.push(['contingent', 1])
  else if (lexicon.HYPOTHETICAL.test(text)) dampers.push(['hypothetical', 0.2])
  if (/\?\s*$/.test(text) && !found.has('request-to-other')) dampers.push(['question', 0.25])
  if (time && !time.deadline && (time.date ?? time.window?.end) < today && !explicitMarker) dampers.push(['past-time', 0.6])
  if (heading) dampers.push(['heading', 0.6])
  for (const [id, factor] of dampers) {
    if (explicitMarker) break
    score *= factor
    found.set(id, 0)
  }
  if (completion) {
    found.set('completion', 0.25)
    score = 0.25
  }
  const flags = { completion, mine: firstPerson.mine, speaker: Boolean(segment.speaker) }
  const clean = dampers.length === 0 && !completion
  const strongCommitment = found.get('first-person-commitment') >= 0.45
  const explicit = explicitMarker || (clean && strongCommitment && firstPerson.any && !segment.speaker && !heading && time !== null && (time.date !== undefined || time.window !== undefined))
  return { found, flags, time, person: personOf(text, extras), score, explicit }
}

/**
 * Finds candidate actions. Returns `{ from, to, text, score, explicit, signals, kindHint, person, time }`
 * sorted by `from`, one per segment, for segments scoring at least CANDIDATE_THRESHOLD.
 */
export function detectActionCandidates(content, { now = new Date(), timeZone = 'UTC' } = {}) {
  const source = String(content)
  const segments = segmentText(source)
  if (!segments.length) return []
  const masked = segments.map((segment) => maskSegment(segment.text))
  const pieces = []
  let cursor = 0
  segments.forEach((segment, index) => {
    pieces.push('¶'.repeat(segment.from - cursor), masked[index])
    cursor = segment.to
  })
  const hits = parseTimeExpressions(pieces.join(''), { now, timeZone }).map((hit) => ({ ...hit, phrase: source.slice(hit.from, hit.to) }))
  const today = dateKeyInZone(now, timeZone)
  const candidates = []
  let hitIndex = 0
  segments.forEach((segment, index) => {
    while (hitIndex < hits.length && hits[hitIndex].to <= segment.from) hitIndex += 1
    const inside = []
    for (let next = hitIndex; next < hits.length && hits[next].from < segment.to; next += 1) {
      if (hits[next].from >= segment.from && hits[next].to <= segment.to) inside.push(hits[next])
    }
    const result = analyze(segment, masked[index], inside, today)
    if (result.score < CANDIDATE_THRESHOLD) return
    const signals = [...result.found.keys()]
    candidates.push({
      from: segment.from,
      to: segment.to,
      text: segment.text,
      score: Math.min(1, Math.round(result.score * 1000) / 1000),
      explicit: result.explicit,
      signals,
      kindHint: kindHintOf(new Set(signals), result.flags),
      person: result.person,
      time: result.time,
    })
  })
  return candidates
}
