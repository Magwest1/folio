import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

const TODO = `---
type: Todo List
title: Todo List
description: A starter task.
status: draft
generated:
  by: human:folio
  at: 2026-09-03T12:00:00.000Z
---

# Todo List

- [ ] Call Sam
- [ ] Email Pat

Select a checkbox to complete or reopen a task.
`

async function startApp(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-actions-routes-'))
  const first = path.join(dataRoot, 'first')
  const second = path.join(dataRoot, 'second')
  await Promise.all([fs.mkdir(first, { recursive: true }), fs.mkdir(second, { recursive: true })])
  await fs.writeFile(path.join(first, 'todo-list.md'), TODO)
  await fs.writeFile(path.join(first, 'meeting.md'), '# Meeting\n\nWe talked.\n\nSend the budget to Sam before Friday.\n')
  await fs.writeFile(path.join(second, 'other.md'), '# Other\n\nBody.\n')
  const app = await createApp(createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot }))
  const one = await app.bundleManager.registry.setup({ name: 'First', markdownPath: first, source: 'existing' })
  const two = await app.bundleManager.registry.setup({ name: 'Second', markdownPath: second, source: 'existing' })
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await app.bundleManager.waitForBackground()
    await app.bundleManager.runtimeFor(one).actionStore.flush()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (bundle, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method, headers: { 'x-folio-bundle': bundle.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json() }
  }
  return { app, one, two, first, call }
}

test('manual actions, filters, validation and transitions over HTTP', async (context) => {
  const { one, call } = await startApp(context)
  const created = await call(one, 'POST', '/api/actions', { text: 'Book the dentist', kind: 'follow-up', person: 'Dr Lie', due: { date: '2026-06-01' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.origin, 'manual')
  const id = created.body.id
  assert.deepEqual((await call(one, 'GET', '/api/actions?kind=follow-up&person=dr%20lie&dueFrom=2026-05-30')).body.map((a) => a.id), [id])
  assert.deepEqual((await call(one, 'GET', '/api/actions?kind=event')).body, [])
  assert.equal((await call(one, 'GET', `/api/actions/${id}`)).body.text, 'Book the dentist')
  assert.equal((await call(one, 'PATCH', `/api/actions/${id}`, { text: 'Book the dentist this week' })).body.editedByUser, true)

  assert.equal((await call(one, 'POST', `/api/actions/${id}/snooze`, { until: '2999-01-01' })).body.status, 'snoozed')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/reopen`)).body.status, 'open')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/let-go`)).body.status, 'let-go')
  assert.deepEqual((await call(one, 'GET', '/api/actions')).body.filter((a) => a.id === id), [], 'closed actions are hidden by default')
  assert.equal((await call(one, 'GET', '/api/actions?includeClosed=true')).body.some((a) => a.id === id), true)
  assert.equal((await call(one, 'POST', `/api/actions/${id}/undo`)).body.status, 'open')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/reject`)).body.status, 'rejected')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/undo`)).body.status, 'open')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/complete`)).body.status, 'done')
  assert.equal((await call(one, 'POST', `/api/actions/${id}/confirm`)).status, 409)

  const fresh = (await call(one, 'POST', '/api/actions', { text: 'Fresh' })).body.id
  assert.equal((await call(one, 'POST', `/api/actions/${fresh}/snooze`, { until: 'whenever' })).status, 400)
  for (const [method, url, body, status] of [
    ['POST', '/api/actions', { text: '' }, 400], ['POST', '/api/actions', { text: 'x', kind: 'chore' }, 400],
    ['POST', '/api/actions', { text: 'x', due: { date: 'soon' } }, 400], ['PATCH', `/api/actions/${id}`, {}, 400],
    ['POST', `/api/actions/${id}/snooze`, { until: '2999-01-01' }, 409], ['GET', '/api/actions?status=bogus', undefined, 400],
    ['GET', '/api/actions?dueFrom=tomorrow', undefined, 400], ['GET', '/api/actions/missing', undefined, 404],
    ['PATCH', '/api/actions/missing', { text: 'x' }, 404], ['POST', '/api/actions/missing/complete', undefined, 404],
    ['POST', '/api/actions/missing/undo', undefined, 404],
  ]) assert.equal((await call(one, method, url, body)).status, status, `${method} ${url}`)
})

test('suppression endpoints and per-bundle stores', async (context) => {
  const { app, one, two, call } = await startApp(context)
  assert.deepEqual((await call(one, 'GET', '/api/actions/suppressions')).body, { sources: [], kinds: [] })
  assert.deepEqual((await call(one, 'POST', '/api/actions/suppressions', { source: '/private/' })).body.sources, ['/private/'])
  assert.deepEqual((await call(one, 'POST', '/api/actions/suppressions', { kind: 'event' })).body.kinds, ['event'])
  assert.equal((await call(one, 'POST', '/api/actions/suppressions', { kind: 'nope' })).status, 400)
  assert.equal((await call(one, 'POST', '/api/actions/suppressions', {})).status, 400)
  assert.equal((await call(one, 'POST', '/api/actions/suppressions', { source: 'no-slash' })).status, 400)
  assert.deepEqual((await call(two, 'GET', '/api/actions/suppressions')).body, { sources: [], kinds: [] }, 'each bundle has its own store')
  assert.notEqual(app.bundleManager.runtimeFor(one).actionStore, app.bundleManager.runtimeFor(two).actionStore)
  assert.deepEqual((await call(one, 'DELETE', '/api/actions/suppressions', { source: '/private/' })).body.sources, [])
  assert.deepEqual((await call(one, 'DELETE', '/api/actions/suppressions?kind=event')).body.kinds, [])
  await call(one, 'POST', '/api/actions', { text: 'Only in first' })
  assert.equal((await call(two, 'GET', '/api/actions')).body.length, 0)
  const file = path.join(app.bundleManager.runtimeFor(one).bundleRoot, '.folio', 'actions.json')
  await app.bundleManager.runtimeFor(one).actionStore.flush()
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).actions.length, 1)
})

test('todo-list checkboxes and actions stay in step in both directions', async (context) => {
  const { one, first, call } = await startApp(context)
  const todoPath = path.join(first, 'todo-list.md')
  const listed = (await call(one, 'GET', '/api/actions')).body.filter((a) => a.origin === 'todo-list')
  assert.deepEqual(listed.map((a) => a.text).sort(), ['Call Sam', 'Email Pat'])
  const sam = listed.find((a) => a.text === 'Call Sam')

  // API to file.
  assert.equal((await call(one, 'POST', `/api/actions/${sam.id}/complete`)).body.status, 'done')
  let file = await fs.readFile(todoPath, 'utf8')
  assert.match(file, /- \[x\] Call Sam\n- \[ \] Email Pat/)
  assert.match(file, /^type: Todo List/m)
  assert.match(file, /Select a checkbox to complete or reopen a task\./)
  assert.equal((await call(one, 'POST', `/api/actions/${sam.id}/reopen`)).body.status, 'open')
  assert.match(await fs.readFile(todoPath, 'utf8'), /- \[ \] Call Sam/)

  // File (saved through the note API) to store.
  const note = (await call(one, 'GET', '/api/file?path=%2Ftodo-list.md')).body
  const ticked = note.content.replace('- [ ] Email Pat', '- [x] Email Pat')
  assert.equal((await call(one, 'PATCH', '/api/note?id=%2Ftodo-list.md', { content: ticked, refreshEmbeddings: false })).status, 200)
  const afterTick = (await call(one, 'GET', '/api/actions?includeClosed=true')).body
  assert.equal(afterTick.find((a) => a.text === 'Email Pat').status, 'done')
  assert.equal(afterTick.find((a) => a.text === 'Call Sam').status, 'open')

  // A removed line orphans, nothing is deleted.
  const removed = ticked.replace('- [ ] Call Sam\n', '')
  await call(one, 'PATCH', '/api/note?id=%2Ftodo-list.md', { content: removed, refreshEmbeddings: false })
  const afterRemove = (await call(one, 'GET', '/api/actions/' + sam.id)).body
  assert.equal(afterRemove.anchor.orphaned, true)
  assert.equal(afterRemove.status, 'open')
  // A stale anchor never writes to the file.
  const before = await fs.readFile(todoPath, 'utf8')
  await call(one, 'POST', `/api/actions/${sam.id}/complete`)
  assert.equal(await fs.readFile(todoPath, 'utf8'), before)
})

test('saving, refiling and deleting notes keep action anchors current', async (context) => {
  const { app, one, call } = await startApp(context)
  const store = app.bundleManager.runtimeFor(one).actionStore
  const quote = 'Send the budget to Sam before Friday.'
  const original = (await call(one, 'GET', '/api/file?path=%2Fmeeting.md')).body.content
  const { added: [action] } = store.addFromExtraction('/meeting.md', [{
    text: 'Send the budget to Sam', kind: 'my-commitment', person: 'Sam', due: null, confidence: 0.9, explicit: true, status: 'open', origin: 'auto',
    anchor: { from: original.indexOf(quote), to: original.indexOf(quote) + quote.length, quote },
  }])
  const edited = `A new opening paragraph.\n\n${original}`
  assert.equal((await call(one, 'PATCH', '/api/note?id=%2Fmeeting.md', { content: edited, refreshEmbeddings: false })).status, 200)
  const anchor = store.get(action.id).anchor
  assert.equal(edited.slice(anchor.from, anchor.to), quote)

  const moved = await call(one, 'POST', '/api/file/move', { id: '/meeting.md', directory: '/projects' })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  assert.equal(store.get(action.id).anchor.noteId, moved.body.newId)

  const noteId = store.get(action.id).anchor.noteId
  assert.equal((await call(one, 'DELETE', `/api/note?id=${encodeURIComponent(noteId)}`)).status, 200)
  assert.equal(store.get(action.id).anchor.orphaned, true)
  assert.equal(store.get(action.id).status, 'open')
})
