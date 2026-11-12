// Calm wording for notifications, in the same family as the Home greeting. Deterministic; no model.
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

export function dayPart(minutes) {
  const hour = Math.floor(minutes / 60)
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

const OPENING = { morning: 'Good morning.', afternoon: 'Good afternoon.', evening: 'Good evening.', night: 'Hello.' }

export function groupTitle(count, minutes) {
  const part = dayPart(minutes)
  const when = part === 'night' ? 'tonight' : `this ${part}`
  return `${plural(count, 'thing', 'things')} for ${when}`
}

function loadPhrase(weekday, things) {
  if (things === 0) return `${weekday} is wide open.`
  if (things <= 2) return `${weekday} looks fairly light.`
  if (things <= 5) return `${weekday} looks steady.`
  return `${weekday} looks full. One thing at a time.`
}

export function briefTitle(dateKey, minutes, things) {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${dateKey}T12:00:00Z`))
  return `${OPENING[dayPart(minutes)]} ${loadPhrase(weekday, things)}`
}

export function briefSummary({ things, waiting, checkins }) {
  return [
    things > 0 ? plural(things, 'thing today', 'things today') : 'Nothing dated today',
    ...(waiting > 0 ? [`${waiting} waiting on others`] : []),
    ...(checkins > 0 ? [`${checkins} to check in on`] : []),
  ].join(' · ')
}
