import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'
import { createSearchService } from '../server/knowledge/search.js'
import { semanticSuggestionState, updateSemanticSuggestions } from '../server/knowledge/suggestions.js'

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// Verbatim copy of the quadratic implementation that noteChunks replaced.
function legacyNoteChunks(content, splitByUtf8Bytes, maxBytes = 1600, overlapBytes = 240) {
  const rawUnits = String(content).match(/\S+\s*/gu) || []
  const units = rawUnits.flatMap((unit) => (
    Buffer.byteLength(unit) > maxBytes ? splitByUtf8Bytes(unit, maxBytes) : [unit]
  ))
  const chunks = []
  let current = []

  const flush = () => {
    const chunk = current.join('').trim()
    if (chunk) chunks.push(chunk)
    const overlap = []
    let bytes = 0
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const unitBytes = Buffer.byteLength(current[index])
      if (bytes + unitBytes > overlapBytes) break
      overlap.unshift(current[index])
      bytes += unitBytes
    }
    current = overlap
  }

  for (const unit of units) {
    if (current.length && Buffer.byteLength(current.join('')) + Buffer.byteLength(unit) > maxBytes) {
      flush()
      if (current.length && Buffer.byteLength(current.join('')) + Buffer.byteLength(unit) > maxBytes) current = []
    }
    current.push(unit)
  }
  if (current.length) {
    const chunk = current.join('').trim()
    if (chunk && chunk !== chunks.at(-1)) chunks.push(chunk)
  }
  return chunks.length ? chunks : [String(content).slice(0, maxBytes)]
}

test('noteChunks matches the previous implementation on varied inputs', () => {
  const { noteChunks, splitByUtf8Bytes } = createSearchService({})
  const random = seededRandom(7)
  const alphabets = ['abcdefghij', 'æøåÆØÅéü', '日本語のテキスト', '😀🎉🚀a', 'ab']
  const separators = [' ', '  ', '\n', '\n\n', '\t', ' \n ', '']
  const word = () => {
    const alphabet = [...alphabets[Math.floor(random() * alphabets.length)]]
    const length = 1 + Math.floor(random() * (random() < 0.05 ? 400 : 14))
    return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
  }
  const inputs = ['', ' ', 'word', '\n\n  \n', 'x'.repeat(5000), '😀'.repeat(900)]
  for (let sample = 0; sample < 60; sample += 1) {
    const count = Math.floor(random() * 700)
    inputs.push(Array.from({ length: count }, () => `${word()}${separators[Math.floor(random() * separators.length)]}`).join(''))
  }
  const settings = [[], [1600, 240], [60, 12], [40, 0], [25, 100], [200, 199]]
  for (const input of inputs) {
    for (const [maxBytes, overlapBytes] of settings) {
      assert.deepEqual(
        noteChunks(input, maxBytes, overlapBytes),
        legacyNoteChunks(input, splitByUtf8Bytes, maxBytes, overlapBytes),
        `maxBytes=${maxBytes} overlapBytes=${overlapBytes} input=${JSON.stringify(input.slice(0, 80))}`,
      )
    }
  }
})

test('incremental semantic suggestions equal the full computation', () => {
  const random = seededRandom(42)
  const dimension = 4
  const centers = Array.from({ length: 4 }, () => Array.from({ length: dimension }, () => random() * 2 - 1))
  const makeEmbedding = () => {
    const center = centers[Math.floor(random() * centers.length)]
    return center.map((value) => value + (random() - 0.5) * 0.5)
  }
  let serial = 0
  const makeRecord = (id) => ({
    id, embedding: random() < 0.85 ? makeEmbedding() : null, embeddingInputHash: `hash-${serial += 1}`, relatedIds: [], suggestedRelatedIds: [],
  })
  // A reindex builds fresh record objects that share embeddings with the previous index.
  const rebuild = (record) => ({ ...record, relatedIds: record.relatedIds.slice(), suggestedRelatedIds: [] })
  let checkedIncremental = 0

  for (let trial = 0; trial < 120; trial += 1) {
    let records = Array.from({ length: 4 + Math.floor(random() * 22) }, (_, index) => makeRecord(`/n${index}.md`))
    let nextId = records.length
    updateSemanticSuggestions(records)
    for (let step = 0; step < 6; step += 1) {
      const state = semanticSuggestionState(records)
      const next = records.map(rebuild)
      const edits = 1 + Math.floor(random() * 4)
      for (let edit = 0; edit < edits; edit += 1) {
        const target = next[Math.floor(random() * next.length)]
        const kind = Math.floor(random() * 8)
        if (kind === 0) next.splice(Math.floor(random() * next.length), 0, makeRecord(`/n${nextId++}.md`))
        else if (kind === 1 && next.length > 2) next.splice(next.indexOf(target), 1)
        else if (kind === 2) { target.embedding = makeEmbedding(); target.embeddingInputHash = `hash-${serial += 1}` }
        else if (kind === 3) { target.embedding = null; target.embeddingInputHash = `hash-${serial += 1}` }
        else if (kind === 4) target.relatedIds = [...new Set([...target.relatedIds, next[Math.floor(random() * next.length)].id])]
        else if (kind === 5) target.relatedIds = target.relatedIds.slice(1)
        else if (kind === 6 && target.suggestedRelatedIds) target.relatedIds = [...new Set([...target.relatedIds, ...(state.get(target.id)?.suggestedRelatedIds || [])])]
        else next.reverse()
      }
      const surviving = new Set(next.map((record) => record.id))
      for (const record of next) record.relatedIds = record.relatedIds.filter((id) => surviving.has(id) && id !== record.id)
      const full = next.map((record) => ({ ...record }))
      updateSemanticSuggestions(full)
      updateSemanticSuggestions(next, state)
      assert.deepEqual(
        next.map((record) => [record.id, record.suggestedRelatedIds]),
        full.map((record) => [record.id, record.suggestedRelatedIds]),
        `trial ${trial} step ${step}`,
      )
      checkedIncremental += next.filter((record) => record.suggestedRelatedIds.length).length
      records = next
    }
  }
  assert.ok(checkedIncremental > 200, 'the scenarios should produce real suggestions')
})

async function startBundle(context, files) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-scaling-'))
  const bundleRoot = path.join(dataRoot, 'vault')
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(bundleRoot, name)), { recursive: true })
    await fs.writeFile(path.join(bundleRoot, name), text)
  }
  await fs.mkdir(bundleRoot, { recursive: true })
  const runtime = createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  })
  const app = await createApp(runtime)
  const bundle = await app.bundleManager.registry.setup({ name: 'Vault', markdownPath: bundleRoot, source: 'existing' })
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
  // Any request prepares the bundle (initial reindex).
  await fetch(`${baseUrl}/api/files`, { headers })
  await app.bundleManager.waitForBackground()
  return { app, bundleRuntime, bundleRoot, baseUrl, headers }
}

function note(title, body, generatedAt) {
  return `---\ntype: Note\ntitle: ${title}\ndescription: About ${title}\ntags:\n  - test\ngenerated:\n  by: human:local\n  at: ${generatedAt}\n---\n\n# Summary\n\n${body}\n`
}

async function snapshotBundle(bundleRoot, indexPath) {
  const snapshot = {}
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '.folio') await walk(entryPath) } else snapshot[path.relative(bundleRoot, entryPath)] = await fs.readFile(entryPath, 'utf8')
    }
  }
  await walk(bundleRoot)
  snapshot['search-index.json'] = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  return snapshot
}

test('an autosave indexes the note immediately and a flush matches a full reindex', async (context) => {
  const { app, bundleRuntime, bundleRoot, baseUrl, headers } = await startBundle(context, {
    'alpha.md': note('Alpha', 'Alpha body.', '2026-01-03T00:00:00.000Z'),
    'beta.md': note('Beta', 'Beta body.', '2026-01-02T00:00:00.000Z'),
    'gamma-project.md': note('Gamma Project', 'Gamma body.', '2026-01-01T00:00:00.000Z'),
  })
  bundleRuntime.deferredReindexDelayMs = 600000
  const indexBefore = await fs.readFile(bundleRuntime.indexPath, 'utf8')

  const response = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent('/alpha.md')}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ content: 'Alpha now covers the Gamma Project and [Beta](beta.md).', baseContent: null, refreshEmbeddings: false }),
  })
  const saved = await response.json()
  assert.equal(response.status, 200, JSON.stringify(saved))
  assert.equal(saved.content, 'Alpha now covers the Gamma Project and [Beta](beta.md).')
  assert.equal(saved.warning, null)
  assert.deepEqual(saved.links.map((link) => link.id), ['/beta.md'])
  assert.deepEqual(saved.backlinks, [])
  assert.deepEqual(Object.keys(saved).filter((key) => ['links', 'backlinks', 'suggestions', 'content', 'oldId', 'newId', 'warning'].includes(key)).sort(),
    ['backlinks', 'content', 'links', 'newId', 'oldId', 'suggestions', 'warning'])

  // Search sees the edit through the in-memory index while the index file waits for the deferred reindex.
  const found = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('covers')}`, { headers }).then((result) => result.json())
  assert.equal(found[0]?.id, '/alpha.md')
  assert.equal(await fs.readFile(bundleRuntime.indexPath, 'utf8'), indexBefore)

  await app.bundleManager.waitForBackground()
  assert.notEqual(await fs.readFile(bundleRuntime.indexPath, 'utf8'), indexBefore)
  const afterFlush = await snapshotBundle(bundleRoot, bundleRuntime.indexPath)
  assert.match(afterFlush['alpha.md'], /folio:generated-related:start/)
  assert.match(afterFlush['index.md'], /Alpha/)

  await bundleRuntime.reindexBundle()
  assert.deepEqual(await snapshotBundle(bundleRoot, bundleRuntime.indexPath), afterFlush)
})

test('the record cache hands out copies and reloads after outside index writes', async (context) => {
  const { bundleRuntime } = await startBundle(context, {
    'alpha.md': note('Alpha', 'Alpha body.', '2026-01-03T00:00:00.000Z'),
  })
  const first = await bundleRuntime.readRecords()
  first[0].title = 'Mutated'
  first[0].chunks[0].content = 'Mutated chunk'
  first[0].tags.push('mutated')
  first.push({ id: '/ghost.md' })
  const second = await bundleRuntime.readRecords()
  assert.equal(second.length, 1)
  assert.equal(second[0].title, 'Alpha')
  assert.notEqual(second[0].chunks[0].content, 'Mutated chunk')
  assert.deepEqual(second[0].tags, ['test'])

  const outside = [{ ...second[0], title: 'Changed elsewhere' }]
  await fs.writeFile(bundleRuntime.indexPath, JSON.stringify(outside))
  assert.equal((await bundleRuntime.readRecords())[0].title, 'Changed elsewhere')
})

test('the parsed document cache cannot be poisoned by callers and notices file changes', async (context) => {
  const { bundleRuntime, bundleRoot } = await startBundle(context, {
    'alpha.md': note('Alpha', 'Alpha body.', '2026-01-03T00:00:00.000Z'),
  })
  const filePath = path.join(bundleRoot, 'alpha.md')
  const old = new Date(Date.now() - 60000)
  await fs.utimes(filePath, old, old)
  const find = async () => (await bundleRuntime.readBundleDocuments()).documents.find((document) => document.id === '/alpha.md')
  const first = await find()
  first.parsed.content = 'poisoned'
  first.parsed.tags.push('poisoned')
  first.relationships.push({ id: '/x.md' })
  const second = await find()
  assert.match(second.parsed.content, /Alpha body\./)
  assert.deepEqual(second.parsed.tags, ['test'])
  assert.deepEqual(second.relationships, [])

  await fs.writeFile(filePath, note('Alpha', 'Alpha body, now much longer than before.', '2026-01-03T00:00:00.000Z'))
  assert.match((await find()).parsed.content, /much longer/)
  await fs.rm(filePath)
  assert.equal(await find(), undefined)
})
