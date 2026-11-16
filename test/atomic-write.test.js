import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeFileAtomic } from '../server/storage/atomic-write.js'

async function withDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-atomic-write-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('writeFileAtomic replaces a file without leaving temporary files', async (context) => {
  const directory = await withDirectory(context)
  const target = path.join(directory, 'note.md')
  await fs.writeFile(target, 'old')
  await writeFileAtomic(target, 'new')
  await writeFileAtomic(target, 'newer', { durable: false })
  assert.equal(await fs.readFile(target, 'utf8'), 'newer')
  assert.deepEqual(await fs.readdir(directory), ['note.md'])
})

test('writeFileAtomic keeps the original intact and cleans up when the write fails', async (context) => {
  const directory = await withDirectory(context)
  const target = path.join(directory, 'note.md')
  await fs.writeFile(target, 'original')
  await assert.rejects(writeFileAtomic(target, { not: 'writable' }))
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(directory), ['note.md'])

  const blocked = path.join(directory, 'blocked.md')
  await fs.mkdir(path.join(blocked, 'child'), { recursive: true })
  await assert.rejects(writeFileAtomic(blocked, 'data'))
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blocked.md', 'note.md'])
})
