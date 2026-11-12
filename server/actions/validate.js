export const KINDS = ['task', 'my-commitment', 'waiting-on', 'follow-up', 'event']
export const STATUSES = ['suggested', 'open', 'snoozed', 'done', 'let-go', 'rejected', 'faded']
export const CLOSED_STATUSES = ['done', 'let-go', 'rejected', 'faded']

export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const validDate = (value) => typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

export function normalizeDue(due) {
  if (due === null || due === undefined) return null
  if (typeof due !== 'object' || Array.isArray(due)) throw httpError(400, 'Due must be null, { date }, or { window }.')
  if (due.window) {
    const { start, end } = due.window
    if (!validDate(start) || !validDate(end) || end < start) throw httpError(400, 'Due window needs valid start and end dates (YYYY-MM-DD).')
    return { window: { start, end } }
  }
  if (!validDate(due.date)) throw httpError(400, 'Due date must be YYYY-MM-DD.')
  if (due.time !== undefined && due.time !== null && !TIME.test(due.time)) throw httpError(400, 'Due time must be HH:MM.')
  return due.time ? { date: due.date, time: due.time } : { date: due.date }
}

export function dueRange(due) {
  if (!due) return null
  if (due.window) return { start: due.window.start, end: due.window.end }
  return due.date ? { start: due.date, end: due.date } : null
}

export function normalizeText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!text) throw httpError(400, 'Action text cannot be empty.')
  if (text.length > 500) throw httpError(400, 'Action text is too long.')
  return text
}

export function normalizeKind(value, fallback = 'task') {
  const kind = value ?? fallback
  if (!KINDS.includes(kind)) throw httpError(400, `Kind must be one of ${KINDS.join(', ')}.`)
  return kind
}

export function normalizePerson(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw httpError(400, 'Person must be a string.')
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null
}

export function normalizeSnooze(value) {
  const parsed = typeof value === 'string' && value ? Date.parse(DATE.test(value) ? `${value}T00:00:00Z` : value) : NaN
  if (Number.isNaN(parsed)) throw httpError(400, 'Snooze needs a valid date or ISO timestamp.')
  return new Date(parsed).toISOString()
}

export function normalizeSource(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length < 2) throw httpError(400, 'Source must be a note id or a folder ending in "/".')
  return value
}

export const asList = (value) => (value === undefined || value === null || value === '' ? null : [].concat(value).flatMap((item) => String(item).split(',')).filter(Boolean))
