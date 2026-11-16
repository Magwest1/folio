import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

async function startFixture(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-external-change-'))
  const bundleRoot = path.join(dataRoot, 'external-vault')
  await fs.mkdir(bundleRoot, { recursive: true })
  const runtime = createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  })
  const app = await createApp(runtime)
  const bundle = await app.bundleManager.registry.setup({ name: 'External', markdownPath: bundleRoot, source: 'existing' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const bundleRuntime = app.bundleManager.runtimeFor(bundle)
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await app.bundleManager.close()
    await bundleRuntime.embeddingRefresh
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }
  const created = await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/', name: 'Outside edits' }),
  }).then((response) => response.json())
  const filePath = path.join(bundleRoot, created.id)
  const getNote = () => fetch(`${baseUrl}/api/file?path=${encodeURIComponent(created.id)}`, { headers }).then((response) => response.json())
  const patch = (body) => fetch(`${baseUrl}/api/note?id=${encodeURIComponent(created.id)}`, {
    method: 'PATCH', headers, body: JSON.stringify({ refreshEmbeddings: false, ...body }),
  })
  const editOutside = async (text) => {
    const markdown = await fs.readFile(filePath, 'utf8')
    const frontmatterEnd = markdown.indexOf('\n---\n', 3) + '\n---\n'.length
    await fs.writeFile(filePath, `${markdown.slice(0, frontmatterEnd)}\n${text}\n`)
  }
  return { baseUrl, headers, created, filePath, getNote, patch, editOutside, bundleRuntime }
}

test('GET /api/file serves the content on disk, not a stale index copy', async (context) => {
  const { getNote, patch, editOutside } = await startFixture(context)
  assert.equal((await patch({ content: 'Saved in the app.', baseContent: null })).status, 200)
  assert.equal((await getNote()).content, 'Saved in the app.')
  await editOutside('Edited by a sync client.')
  assert.equal((await getNote()).content, 'Edited by a sync client.')
})

test('a save over an outside edit keeps the other version in history and warns', async (context) => {
  const { baseUrl, headers, created, getNote, patch, editOutside } = await startFixture(context)
  assert.equal((await patch({ content: 'Version one.', baseContent: null })).status, 200)
  await editOutside('Outside version.')

  const response = await patch({ content: 'Editor version.', baseContent: 'Version one.' })
  const saved = await response.json()
  assert.equal(response.status, 200, JSON.stringify(saved))
  assert.equal(saved.warning, 'This note was changed outside FolioNotes while you were editing. The other version is kept in note history.')
  assert.equal((await getNote()).content, 'Editor version.')

  const history = await fetch(`${baseUrl}/api/note/history?id=${encodeURIComponent(created.id)}`, { headers }).then((result) => result.json())
  const contents = []
  for (const entry of history.entries) {
    const version = await fetch(`${baseUrl}/api/note/history/version?id=${encodeURIComponent(created.id)}&revision=${encodeURIComponent(entry.revision)}`, { headers })
      .then((result) => result.json())
    contents.push(version.note.content)
  }
  assert.ok(contents.some((content) => content.includes('Outside version.')), JSON.stringify(contents))
})

test('a save with a matching base content is written without a warning', async (context) => {
  const { getNote, patch, editOutside } = await startFixture(context)
  assert.equal((await patch({ content: 'Version one.', baseContent: null })).status, 200)
  const second = await patch({ content: 'Version two.', baseContent: 'Version one.' }).then((response) => response.json())
  assert.equal(second.warning, null)
  // Re-sending the same text over an outside edit that already matches it is not a conflict either.
  await editOutside('Version three.')
  const third = await patch({ content: 'Version three.', baseContent: 'Version two.' }).then((response) => response.json())
  assert.equal(third.warning, null)
  assert.equal((await getNote()).content, 'Version three.')
})

test('a save is refused when the outside version cannot be checkpointed', async (context) => {
  const { filePath, patch, editOutside, bundleRuntime } = await startFixture(context)
  assert.equal((await patch({ content: 'Version one.', baseContent: null })).status, 200)
  await editOutside('Outside version.')
  const reconcile = bundleRuntime.history.reconcile
  bundleRuntime.history.reconcile = async () => { throw new Error('history unavailable') }
  context.after(() => { bundleRuntime.history.reconcile = reconcile })

  const response = await patch({ content: 'Editor version.', baseContent: 'Version one.' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'This note changed outside FolioNotes and its current version could not be saved to history. Your edits were not written.',
  })
  assert.match(await fs.readFile(filePath, 'utf8'), /Outside version\./)
})
