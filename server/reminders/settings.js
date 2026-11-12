import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const LEVELS = ['off', 'gentle', 'normal']
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const LEDGER_DAYS = 120
const PENDING_LIMIT = 30

export const DEFAULT_SETTINGS = Object.freeze({
  level: 'gentle',
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
  morningBrief: { enabled: false, time: '08:30' },
  stillRelevantAfterDays: 14,
  fadeAfterDays: 7,
})

const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message) => Object.assign(new Error(message), { status: 400 })
const days = (value, label) => {
  if (!Number.isInteger(value) || value < 1 || value > 365) throw invalid(`${label} must be a whole number of days between 1 and 365.`)
  return value
}
const clock = (value, label) => {
  if (typeof value !== 'string' || !CLOCK.test(value)) throw invalid(`${label} must be a time like 08:30.`)
  return value
}

// Applies a partial update on top of `base`. Strict: a bad value throws a 400 so the form can say so.
export function mergeSettings(base, patch) {
  if (!plain(patch)) throw invalid('Send a JSON object.')
  const next = structuredClone(base)
  if ('level' in patch) {
    if (!LEVELS.includes(patch.level)) throw invalid(`Level must be one of ${LEVELS.join(', ')}.`)
    next.level = patch.level
  }
  if ('quietHours' in patch) {
    if (!plain(patch.quietHours)) throw invalid('Quiet hours must be an object.')
    const { enabled, start, end } = patch.quietHours
    if (enabled !== undefined) next.quietHours.enabled = enabled === true
    if (start !== undefined) next.quietHours.start = clock(start, 'Quiet hours start')
    if (end !== undefined) next.quietHours.end = clock(end, 'Quiet hours end')
  }
  if ('morningBrief' in patch) {
    if (!plain(patch.morningBrief)) throw invalid('Morning brief must be an object.')
    const { enabled, time } = patch.morningBrief
    if (enabled !== undefined) next.morningBrief.enabled = enabled === true
    if (time !== undefined) next.morningBrief.time = clock(time, 'Morning brief time')
  }
  if ('stillRelevantAfterDays' in patch) next.stillRelevantAfterDays = days(patch.stillRelevantAfterDays, 'Still relevant after')
  if ('fadeAfterDays' in patch) next.fadeAfterDays = days(patch.fadeAfterDays, 'Fade after')
  return next
}

// Reads whatever is salvageable field by field, so one bad value never resets the rest.
function sanitize(raw) {
  let settings = structuredClone(DEFAULT_SETTINGS)
  if (!plain(raw)) return settings
  const leaves = [
    ['level'], ['quietHours', 'enabled'], ['quietHours', 'start'], ['quietHours', 'end'],
    ['morningBrief', 'enabled'], ['morningBrief', 'time'], ['stillRelevantAfterDays'], ['fadeAfterDays'],
  ]
  for (const [group, field] of leaves) {
    const value = field ? raw[group]?.[field] : raw[group]
    if (value === undefined) continue
    try { settings = mergeSettings(settings, field ? { [group]: { [field]: value } } : { [group]: value }) } catch { /* keep the default for this field */ }
  }
  return settings
}

function sanitizeLedger(raw) {
  if (!plain(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === 'string' && !Number.isNaN(Date.parse(at))))
}

const sanitizePending = (raw) => (Array.isArray(raw)
  ? raw.filter((item) => plain(item) && typeof item.id === 'string' && Array.isArray(item.actionIds)).slice(-PENDING_LIMIT) : [])

// <bundle>/.folio/reminders.json: settings, the fire-once ledger and reminders nobody has acknowledged yet.
// Atomic writes; an unreadable file is kept as reminders.json.corrupt-<time> and never overwritten.
export function createReminderState(filePath, { now = () => new Date() } = {}) {
  let state = null
  let tail = Promise.resolve()

  function read() {
    let raw
    try { raw = fs.readFileSync(filePath, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Could not read the reminder settings. ${error.message}`)
      return { settings: sanitize(null), ledger: {}, pending: [] }
    }
    try {
      const parsed = JSON.parse(raw)
      if (!plain(parsed) || parsed.version !== 1) throw new Error('Unsupported reminder settings structure.')
      return { settings: sanitize(parsed.settings), ledger: sanitizeLedger(parsed.ledger), pending: sanitizePending(parsed.pending) }
    } catch (error) {
      const preserved = `${filePath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`
      try {
        fs.renameSync(filePath, preserved)
        console.error(`The reminder settings were unreadable (${error.message}). They were kept as ${preserved}.`)
      } catch (renameError) {
        console.error(`The reminder settings were unreadable and could not be preserved. ${renameError.message}`)
      }
      return { settings: sanitize(null), ledger: {}, pending: [] }
    }
  }

  const data = () => (state ||= read())

  function save() {
    tail = tail.then(async () => {
      const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...data() })}\n`)
        await fsp.rename(temporaryPath, filePath)
      } catch (error) {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {})
        console.error(`Could not save the reminder settings. ${error.message}`)
      }
    })
    return tail
  }

  return {
    settings: () => structuredClone(data().settings),
    update(patch) {
      data().settings = mergeSettings(data().settings, patch)
      save()
      return structuredClone(data().settings)
    },
    ledger: () => data().ledger,
    // Stamps keys as fired and drops entries old enough that no instance can still match them.
    record(keys, at = now()) {
      const { ledger } = data()
      for (const key of keys) ledger[key] ??= at.toISOString()
      const cutoff = at.getTime() - LEDGER_DAYS * 86_400_000
      for (const [key, stamp] of Object.entries(ledger)) if (Date.parse(stamp) < cutoff) delete ledger[key]
      save()
    },
    pending: () => structuredClone(data().pending),
    setPending(list) {
      data().pending = list.slice(-PENDING_LIMIT)
      save()
    },
    flush: () => tail,
  }
}
