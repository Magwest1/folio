import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime } from '../server/app.js'
import { createActionStore } from '../server/actions/store.js'
import { PROMPT_VERSION } from '../server/actions/extraction/pipeline.js'
import { createActionService, hashContent } from '../server/actions/service.js'

const INVOICE = '- [ ] Send invoice to Harper by Friday'
const PASSPORT = 'Remember to renew the passport.'
const sentenceOf = (messages) => messages.at(-1).content.match(/<sentence>([\s\S]*?)<\/sentence>/)[1]

// Scripted fake MLX: status, generate and isBusy only.
function scriptedMlx() {
  const mlx = {
    calls: [],
    failing: false,
    status: async () => ({ available: true, models: [{ id: 'gemma4', purpose: 'generation', selected: true, installed: true }] }),
    isBusy: () => false,
    generate: async (messages) => {
      const sentence = sentenceOf(messages)
      mlx.calls.push(sentence)
      if (mlx.failing) throw new Error('worker crashed')
      const reply = /invoice/i.test(sentence) ? { is_action: true, actor: 'me', summary: 'Send invoice to Harper', person: 'Harper', time_phrase: 'Friday' }
        : /passport/i.test(sentence) ? { is_action: true, actor: 'me', summary: 'Renew the passport', person: null, time_phrase: null }
          : { is_action: false, actor: 'unknown', summary: '', person: null, time_phrase: null }
      return { text: JSON.stringify(reply), modelId: 'gemma4' }
    },
  }
  return mlx
}

async function setup(context, notes) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-action-e2e-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const mlx = scriptedMlx()
  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: path.join(dataRoot, 'models') }, mlx)
  const store = createActionStore({ filePath: path.join(runtime.bundleRoot, '.folio', 'actions.json') })
  runtime.actionStore = store
  const bodies = new Map()
  runtime.readRecords = async () => [...bodies].map(([id, content]) => ({ id, content }))
  const service = createActionService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5, timeZone: 'Europe/Oslo' })
  context.after(() => service.close())
  const write = async (id, content) => {
    const filePath = path.join(runtime.bundleRoot, id)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
    bodies.set(id, content)
  }
  const extract = async (id) => { service.enqueue(id); await service.idle() }
  for (const [id, content] of Object.entries(notes)) await write(id, content)
  return { mlx, store, service, write, extract, bodies }
}

const all = (store) => store.list({ includeClosed: true })
const anchored = (store, noteId, content) => all(store).filter((action) => action.anchor?.noteId === noteId)
  .every((action) => !action.anchor.orphaned && content.slice(action.anchor.from, action.anchor.to) === action.anchor.quote)

test('an explicit commitment becomes an open auto action and an ambiguous one a suggestion; note state is recorded', async (context) => {
  const content = `${INVOICE}\n${PASSPORT}\n`
  const { store, mlx, extract } = await setup(context, { '/a.md': content })
  await extract('/a.md')
  const byText = Object.fromEntries(all(store).map((action) => [action.text, action]))
  assert.equal(byText['Send invoice to Harper'].status, 'open')
  assert.equal(byText['Send invoice to Harper'].origin, 'auto')
  assert.equal(byText['Send invoice to Harper'].person, 'Harper')
  assert.equal(byText['Renew the passport'].status, 'suggested')
  assert.equal(byText['Renew the passport'].origin, 'suggested')
  assert.deepEqual(store.noteState('/a.md').contentHash, hashContent(content))
  assert.equal(store.noteState('/a.md').promptVersion, PROMPT_VERSION)
  assert.ok(anchored(store, '/a.md', content))

  const calls = mlx.calls.length
  assert.ok(calls > 0)
  await extract('/a.md')
  assert.equal(mlx.calls.length, calls, 'an unchanged note makes no model calls')
})

test('a let-go action is not re-added after the note is edited and re-extracted', async (context) => {
  const { store, extract, write } = await setup(context, { '/a.md': `${INVOICE}\n` })
  await extract('/a.md')
  const [action] = all(store)
  store.letGo(action.id)
  await write('/a.md', `Intro line.\n${INVOICE}\n`)
  await extract('/a.md')
  assert.equal(all(store).length, 1)
  assert.equal(all(store)[0].status, 'let-go')
  assert.equal(store.list().length, 0, 'nothing open or suggested')
})

test('a completed action blocks the same passage in the same note but not another note', async (context) => {
  const { store, extract, write } = await setup(context, { '/a.md': `${INVOICE}\n`, '/b.md': `${INVOICE}\n` })
  await extract('/a.md')
  store.complete(all(store)[0].id)
  await write('/a.md', `${INVOICE}\nSomething new.\n`)
  await extract('/a.md')
  assert.equal(all(store).length, 1, 'the done passage is not re-added')
  await extract('/b.md')
  const open = store.list()
  assert.equal(open.length, 1)
  assert.equal(open[0].anchor.noteId, '/b.md')
  assert.equal(all(store).length, 2)
})

test('editing a note shifts anchors and reanchor keeps them consistent with the extracted content', async (context) => {
  const { store, extract, write } = await setup(context, { '/a.md': `${INVOICE}\n${PASSPORT}\n` })
  await extract('/a.md')
  const before = all(store).map((action) => action.anchor.from)
  const edited = `A new heading line\n\nMore context before.\n${INVOICE}\n${PASSPORT}\n`
  await write('/a.md', edited)
  const result = store.reanchor('/a.md', edited, { noteVersion: hashContent(edited) })
  assert.equal(result.moved.length, 2)
  assert.ok(anchored(store, '/a.md', edited))
  assert.ok(all(store).every((action, index) => action.anchor.from > before[index]))

  await extract('/a.md')
  assert.equal(all(store).length, 2, 're-extraction updates the existing actions instead of duplicating them')
  assert.ok(anchored(store, '/a.md', edited))
  assert.equal(store.noteState('/a.md').contentHash, hashContent(edited))
})

test('a model failure degrades explicit candidates to suggestions and leaves the note unprocessed', async (context) => {
  const { store, mlx, extract } = await setup(context, { '/a.md': `${INVOICE}\n${PASSPORT}\n` })
  mlx.failing = true
  await extract('/a.md')
  const actions = all(store)
  assert.equal(actions.length, 1, 'only the explicit candidate survives; the other is dropped')
  assert.equal(actions[0].status, 'suggested')
  assert.equal(actions[0].origin, 'suggested')
  assert.equal(store.noteState('/a.md'), null)

  mlx.failing = false
  await extract('/a.md')
  assert.equal(store.noteState('/a.md').promptVersion, PROMPT_VERSION, 'a later run retries and marks the note processed')
  const invoice = all(store).find((action) => /invoice/i.test(action.text))
  assert.equal(invoice.status, 'open', 'the healthy answer promotes the suggestion')
})
