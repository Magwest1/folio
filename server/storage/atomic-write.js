import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Writes to a hidden sibling temp file and renames it over the target so a crash
// can never leave a truncated file. The temp name starts with "." and does not end
// in ".md", so bundle listings never pick it up.
export async function writeFileAtomic(filePath, data, { durable = true } = {}) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  let handle = null
  try {
    handle = await fs.open(temporaryPath, 'wx')
    await handle.writeFile(data)
    if (durable) await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
