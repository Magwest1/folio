// Deterministic action kind from the model's actor and the detector's hint and signals.
// Returns the kind, or null when the candidate is someone else's task (dropped by the pipeline).
export function deriveKind({ actor, kindHint, signals }) {
  const has = (signal) => signals.includes(signal)
  if (actor === 'other') return has('waiting') || has('request-to-other') ? 'waiting-on' : null
  if (kindHint === 'waiting-on' || has('waiting')) return 'waiting-on'
  if (kindHint === 'follow-up' || has('follow-up')) return 'follow-up'
  if (kindHint === 'event') return 'event'
  if (kindHint === 'my-commitment' && actor === 'me') return 'my-commitment'
  return 'task'
}
