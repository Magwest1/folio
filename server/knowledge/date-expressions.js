// Deterministic English/Norwegian date and time expression parser.
//
// Decisions (kept stable because the action detector and its evaluation rely on them):
// - Spans exclude introducing prepositions and deadline markers ("by", "on", "innen", "på"); `deadline`
//   reports the marker instead. Time spans keep their own marker ("at 3pm", "kl. 14").
// - A bare weekday and "next <weekday>" resolve to the next occurrence strictly after today; "this <weekday>"
//   resolves to the next occurrence on or after today; "last <weekday>" to the most recent one before today.
//   Only "today"/"i dag" means today.
// - Weeks run Monday..Sunday. "end of week" is Friday..Sunday (start clamped to today), "end of month" is the
//   last day of the month (start = end), "end of day" is today.
// - Parts of day map to a conventional time: morning/tidlig 09:00, formiddag 10:00, afternoon/ettermiddag 15:00,
//   evening/tonight/kveld 18:00, night/natt 21:00.
// - Dates without a year resolve to the next occurrence on or after today. "dd/mm" falls back to "mm/dd" when
//   the day exceeds 12. Short numeric dates such as "1.2" (versions, decimals) are ignored.
// - Weekends are Saturday..Sunday ranges; Easter is the Maundy Thursday..Easter Monday range of the next Easter.
// - A bare "HH:MM" or "at 10" only counts when it is attached to a date ("Friday at 10"). A marked time without a date ("kl 14") is
//   returned as a 'datetime' hit with `time` but no `date`.
const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
  sondag: 0, lordag: 6, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4,
}
const MONTHS = {
  january: 1, januar: 1, jan: 1, february: 2, februar: 2, feb: 2, march: 3, mars: 3, mar: 3, april: 4, apr: 4,
  may: 5, mai: 5, june: 6, juni: 6, jun: 6, july: 7, juli: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oktober: 10, oct: 10, okt: 10, november: 11, nov: 11,
  december: 12, desember: 12, dec: 12, des: 12,
}
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  en: 1, ett: 1, ei: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, åtte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12,
}
const PARTS_OF_DAY = {
  morning: '09:00', tidlig: '09:00', formiddag: '10:00', afternoon: '15:00', ettermiddag: '15:00',
  evening: '18:00', kveld: '18:00', tonight: '18:00', night: '21:00', natt: '21:00',
}

const START = '(?<![\\p{L}\\p{N}_])'
const END = '(?![\\p{L}\\p{N}_])'
const alt = (words) => Object.keys(words).sort((a, b) => b.length - a.length).join('|')
const WEEKDAY_ALT = alt(WEEKDAYS)
const MONTH_ALT = alt(MONTHS)
const NUMBER_ALT = `\\d{1,3}|${alt(NUMBER_WORDS)}`
const POD_ALT = 'morning|afternoon|evening|night|tidlig|formiddag|ettermiddag|kveld|natt'
const UNIT_ALT = 'days?|weeks?|months?|hours?|hrs?|minutes?|mins?|dager|dag|uker|uke|uka|måneder|måned|timer|time|minutter|minutt|min'
const re = (source) => new RegExp(source, 'giu')

const DAY_WORD = re(`${START}(?:(?:the\\s+)?day\\s+after\\s+tomorrow|today|tomorrow|yesterday|tonight|i\\s+dag|idag|i\\s+morgen|imorgen|i\\s+går|igår|i\\s+overmorgen|overmorgen|i\\s+kveld|this\\s+(?:morning|afternoon|evening))(?:\\s+(${POD_ALT}))?${END}`)
const WEEKDAY = re(`${START}(?:(next|this|last|coming|neste|kommende|forrige|denne)\\s+)?(${WEEKDAY_ALT})(?:\\s+(${POD_ALT}))?${END}`)
const WEEK = re(`${START}(this|next|last|coming|denne|neste|kommende|forrige)\\s+(week|uke|uka|uken)${END}`)
const MONTH = re(`${START}(this|next|last|coming|denne|neste|kommende|forrige)\\s+(month|måneden|måned)${END}`)
const END_OF = re(`${START}(?:(eod|cob)|(?:the\\s+)?(?:end|close)\\s+of\\s+(?:the\\s+)?(?:(this|next)\\s+)?(week|month|day)|(?:slutten|utgangen|enden)\\s+av\\s+(?:(denne|neste)\\s+)?(uka|uke|uken|måneden|måned|dagen))${END}`)
const OFFSET = re(`${START}(in|within|om|innen)\\s+(${NUMBER_ALT})\\s+(${UNIT_ALT})${END}`)
const WEEKEND = re(`${START}(?:(i)\\s+(?:helga|helgen)|(?:(this|next|denne|neste|kommende)\\s+)?(weekend|helga|helgen|helg))${END}`)
const EASTER = re(`${START}(?:easter|påske|påsken|påska)${END}`)
const ISO = re(`(?<![\\p{L}\\p{N}.\\-/:])(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2}))?(?![\\p{N}]|-\\d)`)
const NUMERIC = re('(?<![\\p{L}\\p{N}./:$€£])(\\d{1,2})([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?![\\p{N}%/:]|\\.\\d)')
const DAY_MONTH = re(`${START}(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s*(?:of\\s+)?(${MONTH_ALT})(?:\\.?,?\\s*(\\d{4}))?${END}`)
const MONTH_DAY = re(`${START}(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{N}:])(?:,?\\s*(\\d{4}))?${END}`)
const CLOCK_NO = re(`${START}(?:kl\\.?|klokka|klokken)\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?![\\p{L}\\p{N}:])`)
const CLOCK_AMPM = re(`${START}(?:(?:at|@)\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap])(?:\\.m\\.|m)${END}`)
const CLOCK_AT = re(`${START}(?:at|@)\\s*(\\d{1,2}):(\\d{2})(?![\\p{N}:])`)
const CLOCK_AT_HOUR = re(`${START}(?:at|@)\\s*(\\d{1,2})(?![\\p{N}:]|\\.\\d)`)
const CLOCK_BARE = re('(?<![\\p{L}\\p{N}:.])(\\d{1,2}):(\\d{2})(?![\\p{N}:])')
const NOT_A_DATE_UNIT = /^\s*(?:%|kr\b|nok|usd|eur|dollar|hours?|hrs?|timer|time\b|min\b|mill|million|[mgk]b\b|kg|km|cm|mm\b|ms\b)/i
const DEADLINE_BEFORE = new RegExp(`(?:^|[^\\p{L}])(?:(?:(?:by|before|until|till|due|no\\s+later\\s+than|not\\s+later\\s+than|innen|før|senest|til|inntil|frem\\s+til|fram\\s+til)\\s+|(?:deadline|due\\s+date|frist)\\s*[:\\-–]?\\s*)(?:(?:on|the|på|utgangen\\s+av)\\s+)*)+$`, 'iu')
const TIME_GAP = /^[\s,]*(?:on|på|the|den)?[\s,]*$/i
const RANGE_GAP = /^\s*(?:-|–|—|to|through|thru|til|until)\s*$/i

const formatters = new Map()
function localParts(date, timeZone) {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(timeZone, format)
  }
  const parts = {}
  for (const part of format.formatToParts(date)) parts[part.type] = part.value
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** Calendar date (YYYY-MM-DD) of `now` in `timeZone`. */
export function dateKeyInZone(now, timeZone = 'UTC') {
  return localParts(now, timeZone).date
}

const pad = (value) => String(value).padStart(2, '0')
const atNoon = (key) => new Date(`${key}T12:00:00.000Z`)
function addDays(key, amount) {
  const date = atNoon(key)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
const weekdayOf = (key) => atNoon(key).getUTCDay()
const mondayOf = (key) => addDays(key, weekdayOf(key) === 0 ? -6 : 1 - weekdayOf(key))
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const validDate = (year, month, day) => month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
const keyOf = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`
function addMonths(key, amount) {
  const [year, month, day] = key.split('-').map(Number)
  const index = year * 12 + (month - 1) + amount
  const targetYear = Math.floor(index / 12)
  const targetMonth = (index % 12) + 1
  return keyOf(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)))
}
const monthWindow = (year, month) => ({ start: keyOf(year, month, 1), end: keyOf(year, month, daysInMonth(year, month)) })

function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const g = Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return keyOf(year, month, day)
}

function nextYearlyDate(today, month, day, explicitYear) {
  const todayYear = Number(today.slice(0, 4))
  if (explicitYear) return validDate(explicitYear, month, day) ? keyOf(explicitYear, month, day) : null
  for (let year = todayYear; year <= todayYear + 8; year += 1) {
    if (!validDate(year, month, day)) continue
    const key = keyOf(year, month, day)
    if (key >= today) return key
  }
  return null
}

const lower = (value) => value.toLocaleLowerCase('en')
const numberOf = (word) => (/^\d/.test(word) ? Number(word) : NUMBER_WORDS[lower(word)])
const dayHit = (match, date, extra = {}) => ({ from: match.index, to: match.index + match[0].length, kind: 'day', date, ...extra })
const windowHit = (match, precision, window) => ({ from: match.index, to: match.index + match[0].length, kind: precision, window })
const timeHit = (match, hour, minute, extra = {}) => (hour > 23 || minute > 59 ? null : { from: match.index, to: match.index + match[0].length, kind: 'time', time: `${pad(hour)}:${pad(minute)}`, ...extra })
const podTime = (word) => PARTS_OF_DAY[lower(word)]

function weekdayDate(today, modifier, weekday) {
  const difference = WEEKDAYS[lower(weekday)] - weekdayOf(today)
  if (['last', 'forrige'].includes(modifier)) return addDays(today, difference < 0 ? difference : difference - 7)
  if (['this', 'denne'].includes(modifier)) return addDays(today, difference >= 0 ? difference : difference + 7)
  return addDays(today, difference > 0 ? difference : difference + 7)
}

function relativeDayDate(phrase, today) {
  const word = lower(phrase).replace(/\s+/g, ' ')
  if (/day after tomorrow|overmorgen/.test(word)) return addDays(today, 2)
  if (/tomorrow|morgen/.test(word)) return addDays(today, 1)
  if (/yesterday|går/.test(word)) return addDays(today, -1)
  return today
}

function leadingPartOfDay(phrase) {
  const word = lower(phrase)
  if (/^(?:tonight|i\s+kveld)/.test(word)) return PARTS_OF_DAY.tonight
  const suffix = word.match(/\s+(\p{L}+)$/u)
  return suffix ? podTime(suffix[1]) : undefined
}

function scanRelative(text, ctx, hits) {
  const { today } = ctx
  for (const match of text.matchAll(DAY_WORD)) {
    const time = leadingPartOfDay(match[0])
    hits.push(dayHit(match, relativeDayDate(match[0], today), time ? { time } : {}))
  }
  for (const match of text.matchAll(WEEKDAY)) {
    const time = match[3] ? podTime(match[3]) : undefined
    hits.push(dayHit(match, weekdayDate(today, match[1] ? lower(match[1]) : '', match[2]), { weekday: true, ...(time ? { time } : {}) }))
  }
  for (const match of text.matchAll(WEEK)) {
    const modifier = lower(match[1])
    const offset = ['next', 'neste', 'coming', 'kommende'].includes(modifier) ? 7 : ['last', 'forrige'].includes(modifier) ? -7 : 0
    const start = addDays(mondayOf(today), offset)
    hits.push(windowHit(match, 'week', { start, end: addDays(start, 6) }))
  }
  for (const match of text.matchAll(MONTH)) {
    const modifier = lower(match[1])
    const offset = ['next', 'neste', 'coming', 'kommende'].includes(modifier) ? 1 : ['last', 'forrige'].includes(modifier) ? -1 : 0
    const [year, month] = addMonths(`${today.slice(0, 7)}-01`, offset).split('-').map(Number)
    hits.push(windowHit(match, 'month', monthWindow(year, month)))
  }
  for (const match of text.matchAll(END_OF)) scanEndOf(match, today, hits)
  for (const match of text.matchAll(WEEKEND)) {
    const modifier = lower(match[2] ?? '')
    const saturday = addDays(mondayOf(today), 5)
    const upcoming = saturday < today ? today : saturday
    const start = ['next', 'neste', 'kommende'].includes(modifier) ? addDays(saturday, 7) : upcoming
    hits.push(windowHit(match, 'range', { start, end: addDays(saturday, ['next', 'neste', 'kommende'].includes(modifier) ? 8 : 1) }))
  }
  for (const match of text.matchAll(EASTER)) {
    const year = Number(today.slice(0, 4))
    let sunday = easterSunday(year)
    if (addDays(sunday, 1) < today) sunday = easterSunday(year + 1)
    hits.push(windowHit(match, 'range', { start: addDays(sunday, -3), end: addDays(sunday, 1) }))
  }
  for (const match of text.matchAll(OFFSET)) scanOffset(match, ctx, hits)
}

function scanEndOf(match, today, hits) {
  const unit = lower(match[3] ?? match[5] ?? 'day')
  const modifier = lower(match[2] ?? match[4] ?? '')
  const next = modifier === 'next' || modifier === 'neste'
  if (match[1] || ['day', 'dagen'].includes(unit)) { hits.push(dayHit(match, today)); return }
  if (['week', 'uka', 'uke', 'uken'].includes(unit)) {
    const monday = addDays(mondayOf(today), next ? 7 : 0)
    const start = addDays(monday, 4)
    hits.push(windowHit(match, 'week', { start: start < today ? today : start, end: addDays(monday, 6) }))
    return
  }
  const [year, month] = addMonths(`${today.slice(0, 7)}-01`, next ? 1 : 0).split('-').map(Number)
  const end = keyOf(year, month, daysInMonth(year, month))
  hits.push(windowHit(match, 'month', { start: end, end }))
}

function scanOffset(match, ctx, hits) {
  const amount = numberOf(match[2])
  if (!amount) return
  const unit = lower(match[3])
  const deadline = ['within', 'innen'].includes(lower(match[1]))
  const extra = deadline ? { forceDeadline: true } : {}
  if (/^(?:hours?|hrs?|timer|time|minutes?|mins?|minutter|minutt|min)$/.test(unit)) {
    const minutes = /^(?:h|t)/.test(unit) ? amount * 60 : amount
    const parts = localParts(new Date(ctx.now.getTime() + minutes * 60000), ctx.timeZone)
    hits.push(dayHit(match, parts.date, { time: parts.time, ...extra }))
    return
  }
  const date = /^(?:month|måned)/.test(unit) ? addMonths(ctx.today, amount) : addDays(ctx.today, amount * (/^(?:week|uke)/.test(unit) ? 7 : 1))
  hits.push(dayHit(match, date, extra))
}

function scanExplicit(text, ctx, hits) {
  const { today } = ctx
  for (const match of text.matchAll(ISO)) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (!validDate(year, month, day)) continue
    const time = match[4] === undefined ? undefined : `${match[4]}:${match[5]}`
    hits.push(dayHit(match, keyOf(year, month, day), time && Number(match[4]) < 24 && Number(match[5]) < 60 ? { time, explicitTime: true } : {}))
  }
  for (const match of text.matchAll(NUMERIC)) {
    const first = Number(match[1])
    const second = Number(match[3])
    if (!match[4] && match[1].length < 2 && match[3].length < 2) continue
    if (NOT_A_DATE_UNIT.test(text.slice(match.index + match[0].length, match.index + match[0].length + 12))) continue
    const year = match[4] ? (match[4].length === 2 ? 2000 + Number(match[4]) : Number(match[4])) : undefined
    let [day, month] = [first, second]
    if (match[2] === '/' && !validDate(year ?? 2024, month, day) && validDate(year ?? 2024, first, second)) [day, month] = [second, first]
    const date = month >= 1 && month <= 12 ? nextYearlyDate(today, month, day, year) : null
    if (date) hits.push(dayHit(match, date))
  }
  for (const [pattern, dayIndex, monthIndex, yearIndex] of [[DAY_MONTH, 1, 2, 3], [MONTH_DAY, 2, 1, 3]]) {
    for (const match of text.matchAll(pattern)) {
      const monthWord = match[monthIndex]
      if (lower(monthWord) === 'may' && monthWord[0] !== 'M') continue
      const date = nextYearlyDate(today, MONTHS[lower(monthWord)], Number(match[dayIndex]), match[yearIndex] ? Number(match[yearIndex]) : undefined)
      if (date) hits.push(dayHit(match, date))
    }
  }
}

function scanTimes(text, hits) {
  for (const match of text.matchAll(CLOCK_NO)) hits.push(timeHit(match, Number(match[1]), Number(match[2] ?? 0)))
  for (const match of text.matchAll(CLOCK_AMPM)) {
    const hour = Number(match[1])
    if (hour < 1 || hour > 12) continue
    hits.push(timeHit(match, (hour % 12) + (lower(match[3]) === 'p' ? 12 : 0), Number(match[2] ?? 0)))
  }
  for (const match of text.matchAll(CLOCK_AT)) hits.push(timeHit(match, Number(match[1]), Number(match[2])))
  for (const match of text.matchAll(CLOCK_AT_HOUR)) hits.push(timeHit(match, Number(match[1]), 0, { bare: true }))
  for (const match of text.matchAll(CLOCK_BARE)) hits.push(timeHit(match, Number(match[1]), Number(match[2]), { bare: true }))
}

function overlapping(hits) {
  const ordered = hits.filter(Boolean).sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)
  const kept = []
  for (const hit of ordered) {
    if (!kept.some((other) => hit.from < other.to && other.from < hit.to)) kept.push(hit)
  }
  return kept.sort((a, b) => a.from - b.from)
}

function mergeWeekdayDates(text, hits) {
  const merged = []
  for (let index = 0; index < hits.length; index += 1) {
    const current = hits[index]
    const next = hits[index + 1]
    if (current.weekday && !current.time && next && next.kind === 'day' && !next.weekday && /^[\s,.]*(?:den\s+)?$/i.test(text.slice(current.to, next.from))) {
      merged.push({ ...next, from: current.from })
      index += 1
    } else {
      merged.push(current)
    }
  }
  return merged
}

function mergeTimes(text, hits) {
  const merged = []
  for (let index = 0; index < hits.length; index += 1) {
    const current = hits[index]
    const next = hits[index + 1]
    const pair = next && ((current.kind === 'day' && next.kind === 'time') || (current.kind === 'time' && next.kind === 'day'))
    if (pair && TIME_GAP.test(text.slice(current.to, next.from))) {
      const [dayPart, timePart] = current.kind === 'day' ? [current, next] : [next, current]
      if (!dayPart.explicitTime) {
        merged.push({ ...dayPart, from: current.from, to: next.to, time: timePart.time, merged: true })
        index += 1
        continue
      }
    }
    merged.push(current)
  }
  return merged.filter((hit) => !(hit.kind === 'time' && hit.bare))
}

function mergeRanges(text, hits) {
  const merged = []
  for (let index = 0; index < hits.length; index += 1) {
    const current = hits[index]
    const next = hits[index + 1]
    if (next && current.kind === 'day' && next.kind === 'day' && !current.time && !next.time && RANGE_GAP.test(text.slice(current.to, next.from))) {
      let end = next.date
      while (end < current.date && /^[\p{L}]+$/u.test(text.slice(next.from, next.to))) end = addDays(end, 7)
      if (end >= current.date) {
        merged.push({ from: current.from, to: next.to, kind: 'range', window: { start: current.date, end } })
        index += 1
        continue
      }
    }
    merged.push(current)
  }
  return merged
}

function finish(text, hit) {
  const marker = DEADLINE_BEFORE.test(text.slice(Math.max(0, hit.from - 48), hit.from))
  const result = { from: hit.from, to: hit.to, phrase: text.slice(hit.from, hit.to), precision: hit.kind === 'time' ? 'datetime' : hit.kind, deadline: marker || Boolean(hit.forceDeadline) }
  if (hit.kind === 'day') {
    result.date = hit.date
    if (hit.time) { result.time = hit.time; result.precision = 'datetime' }
  } else if (hit.kind === 'time') {
    result.time = hit.time
  } else {
    result.window = hit.window
  }
  return result
}

/**
 * Finds date and time expressions in `text`. Returns hits sorted by `from`:
 * `{ from, to, phrase, precision, date?, time?, window?, deadline }`.
 */
export function parseTimeExpressions(text, { now = new Date(), timeZone = 'UTC' } = {}) {
  const source = String(text)
  const ctx = { now, timeZone, today: dateKeyInZone(now, timeZone) }
  const hits = []
  scanRelative(source, ctx, hits)
  scanExplicit(source, ctx, hits)
  scanTimes(source, hits)
  const resolved = mergeRanges(source, mergeTimes(source, mergeWeekdayDates(source, overlapping(hits))))
  return resolved.map((hit) => finish(source, hit)).filter(Boolean)
}
