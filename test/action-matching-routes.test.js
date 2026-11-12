import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

async function startApp(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-matching-routes-'))
  const first = path.join(dataRoot, 'first')
  await fs.mkdir(first, { recursive: true })
  await fs.writeFile(path.join(first, 'plan.md'), '# Plan\n\nSend the budget to Sam.\n')
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const bundle = await app.bundleManager.registry.setup({ name: 'First', markdownPath: first, source: 'existing' })
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const store = app.bundleManager.runtimeFor(bundle).actionStore
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await app.bundleManager.waitForBackground()
    await store.flush()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const call = async (method, url) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'x-folio-bundle': bundle.id } })
    return { status: response.status, body: await response.json() }
  }
  return { store, call }
}

const extracted = (text, quote) => ({ text, kind: 'task', person: 'Sam', due: null, confidence: 0.9, explicit: true, status: 'open', origin: 'auto', anchor: { from: 0, to: quote.length, quote }, signals: [] })

test('accepting a completion suggestion marks the action done and the regular undo takes it back', async (context) => {
  const { store, call } = await startApp(context)
  const [action] = store.addFromExtraction('/plan.md', [extracted('Send the budget to Sam', 'Send the budget to Sam.')]).added
  assert.equal((await call('POST', `/api/actions/${action.id}/completion/accept`)).status, 409, 'nothing to accept yet')
  store.suggestCompletion(action.id, { noteId: '/journal.md', quote: 'Emailed the budget to Sam.', score: 0.74 })
  const listed = (await call('GET', '/api/actions')).body.find((item) => item.id === action.id)
  assert.equal(listed.completionSuggestion.quote, 'Emailed the budget to Sam.')
  assert.deepEqual(listed.anchors, [])
  const accepted = await call('POST', `/api/actions/${action.id}/completion/accept`)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.status, 'done')
  assert.equal(accepted.body.completionSuggestion, null)
  assert.equal((await call('POST', `/api/actions/${action.id}/undo`)).body.status, 'open')
  assert.equal((await call('POST', '/api/actions/missing/completion/accept')).status, 404)
})

test('dismissing a completion suggestion clears it and the same evidence is not suggested again', async (context) => {
  const { store, call } = await startApp(context)
  const [action] = store.addFromExtraction('/plan.md', [extracted('Send the budget to Sam', 'Send the budget to Sam.')]).added
  store.suggestCompletion(action.id, { noteId: '/journal.md', quote: 'Emailed the budget to Sam.' })
  const dismissed = await call('POST', `/api/actions/${action.id}/completion/dismiss`)
  assert.equal(dismissed.status, 200)
  assert.equal(dismissed.body.completionSuggestion, null)
  assert.equal(dismissed.body.status, 'open')
  assert.equal(store.suggestCompletion(action.id, { noteId: '/journal.md', quote: 'Emailed the budget to Sam.' }), null)
  assert.equal((await call('POST', `/api/actions/${action.id}/completion/dismiss`)).status, 200, 'dismissing again is harmless')
})

test('undo reverts automatic completions and merged repeats, and the JSON exposes the system history', async (context) => {
  const { store, call } = await startApp(context)
  const [action] = store.addFromExtraction('/plan.md', [extracted('Send the budget to Sam', 'Send the budget to Sam.')]).added
  store.mergeRepeat(action.id, extracted('Send the budget to Sam', 'I will send the budget to Sam.'), { noteId: '/journal.md' })
  const merged = (await call('GET', `/api/actions/${action.id}`)).body
  assert.equal(merged.anchors[0].noteId, '/journal.md')
  assert.deepEqual([merged.history.at(-1).by, merged.history.at(-1).reason], ['system', 'repeat'])
  store.completeFromEvidence(action.id, { noteId: '/journal.md', quote: 'Sent the budget to Sam.', score: 0.99 })
  const done = (await call('GET', `/api/actions/${action.id}`)).body
  assert.equal(done.status, 'done')
  assert.equal(done.completion.noteId, '/journal.md')
  const first = await call('POST', `/api/actions/${action.id}/undo`)
  assert.equal(first.body.status, 'open')
  assert.equal(first.body.anchors.length, 1)
  const second = await call('POST', `/api/actions/${action.id}/undo`)
  assert.equal(second.body.anchors.length, 0)
})
