// Wall-clock helpers for the reminder planner. Dates are YYYY-MM-DD keys in a named time zone.
const formatters = new Map()

export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); return true } catch { return false }
}

export function localParts(date, timeZone = 'UTC') {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timeZone, format)
  }
  const parts = {}
  for (const part of format.formatToParts(date)) parts[part.type] = part.value
  const time = `${parts.hour}:${parts.minute}`
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

export const clockMinutes = (time) => {
  const [hour, minute] = String(time).split(':').map(Number)
  return hour * 60 + minute
}

export function addDays(key, amount) {
  const date = new Date(`${key}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

// The instant at which the wall clock in `timeZone` reads `dateKey` `time`.
export function zonedInstant(dateKey, time, timeZone = 'UTC') {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wanted
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(guess), timeZone)
    const [ly, lm, ld] = local.date.split('-').map(Number)
    guess += wanted - Date.UTC(ly, lm - 1, ld, Math.floor(local.minutes / 60), local.minutes % 60)
  }
  return new Date(guess)
}
