// Strict parser for the per-span model answer. Tolerates code fences and prose around the JSON object.
export class ActionOutputError extends Error {
  constructor(message, reason = 'invalid-output') {
    super(message)
    this.name = 'ActionOutputError'
    this.code = 'INVALID_ACTION_OUTPUT'
    this.reason = reason
  }
}

export const ACTORS = ['me', 'other', 'we', 'unknown']
export const MAX_SUMMARY_WORDS = 14
const KEYS = ['is_action', 'actor', 'summary', 'person', 'time_phrase']

function extractJson(text) {
  const source = String(text ?? '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = (fenced || source).trim()
  const start = candidate.indexOf('{')
  if (start < 0) return candidate
  // Take the first balanced object so trailing prose containing braces does not break parsing.
  let depth = 0
  let inString = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return candidate.slice(start, index + 1)
  }
  return candidate.slice(start)
}

function nullableString(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new ActionOutputError(`${field} must be a string or null.`)
  const trimmed = value.trim()
  return trimmed && trimmed.toLocaleLowerCase() !== 'null' ? trimmed : null
}

/** Returns `{ isAction, actor, summary, person, timePhrase }` or throws ActionOutputError. */
export function parseSpanOutput(text) {
  let result
  try {
    result = JSON.parse(extractJson(text))
  } catch {
    throw new ActionOutputError('The model returned malformed or truncated JSON.', 'bad-json')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ActionOutputError('The model answer must be one JSON object.', 'bad-json')
  if (Object.keys(result).some((key) => !KEYS.includes(key))) throw new ActionOutputError('The model answer has unexpected keys.', 'bad-shape')
  if (typeof result.is_action !== 'boolean') throw new ActionOutputError('is_action must be a boolean.', 'bad-shape')
  if (!ACTORS.includes(result.actor)) {
    if (result.is_action) throw new ActionOutputError('actor must be me, other, we or unknown.', 'bad-shape')
  }
  const actor = ACTORS.includes(result.actor) ? result.actor : 'unknown'
  const summary = nullableString(result.summary, 'summary') ?? ''
  const person = nullableString(result.person, 'person')
  const timePhrase = nullableString(result.time_phrase, 'time_phrase')
  // An empty or over-long summary is not worth failing the whole answer for: the pipeline falls back to the span text.
  const usable = summary.split(/\s+/).filter(Boolean).length <= MAX_SUMMARY_WORDS
  return { isAction: result.is_action, actor, summary: usable ? summary : '', person, timePhrase }
}
