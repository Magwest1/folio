import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const emptyState = () => ({
  version: 1, actions: [], suppressions: { sources: [], kinds: [] }, feedback: [], noteStates: {},
})

function validState(parsed) {
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  return plain(parsed) && parsed.version === 1 && Array.isArray(parsed.actions)
    && (parsed.suppressions === undefined || plain(parsed.suppressions))
    && (parsed.feedback === undefined || Array.isArray(parsed.feedback))
    && (parsed.noteStates === undefined || plain(parsed.noteStates))
}

// Reads synchronously so every store call is safe even before load() resolves.
// An unreadable file is preserved as actions.json.corrupt-<timestamp> and never overwritten.
export function readState(filePath, now) {
  let raw
  try { raw = fs.readFileSync(filePath, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read the action store. ${error.message}`)
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw)
    if (!validState(parsed)) throw new Error('Unsupported action store structure.')
    const base = emptyState()
    return {
      ...base,
      actions: parsed.actions,
      suppressions: {
        sources: Array.isArray(parsed.suppressions?.sources) ? parsed.suppressions.sources : [],
        kinds: Array.isArray(parsed.suppressions?.kinds) ? parsed.suppressions.kinds : [],
      },
      feedback: parsed.feedback || [],
      noteStates: parsed.noteStates || {},
    }
  } catch (error) {
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const preserved = `${filePath}.corrupt-${stamp}`
    try {
      fs.renameSync(filePath, preserved)
      console.error(`The action store was unreadable (${error.message}). It was kept as ${preserved}.`)
    } catch (renameError) {
      console.error(`The action store was unreadable and could not be preserved. ${renameError.message}`)
    }
    return emptyState()
  }
}

// Whole-file atomic writes (temp file plus rename), serialized on a promise tail.
export function createWriter(filePath, snapshot) {
  let tail = Promise.resolve()
  function save() {
    tail = tail.then(async () => {
      const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(temporaryPath, `${JSON.stringify(snapshot())}\n`)
        await fsp.rename(temporaryPath, filePath)
      } catch (error) {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {})
        console.error(`Could not save the actions. ${error.message}`)
      }
    })
    return tail
  }
  return { save, flush: () => tail }
}
