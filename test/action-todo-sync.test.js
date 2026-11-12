import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActionStore } from '../server/actions/store.js'
import { TODO_LIST_ID, parseTodoLines, syncTodoList } from '../server/actions/todo-sync.js'

const seed = await fs.readFile(new URL('../seed-data/bundle/todo-list.md', import.meta.url), 'utf8')
const seedBody = seed.slice(seed.indexOf('\n---\n', 4) + 5).trim()

async function newStore(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-todo-sync-'))
  const store = createActionStore({ filePath: path.join(dir, 'actions.json') })
  context.after(async () => { await store.flush(); await fs.rm(dir, { recursive: true, force: true }) })
  return store
}

const todos = (store) => store.list({ noteId: TODO_LIST_ID, includeClosed: true })

test('parses checkbox lines and ignores instructional prose, fences and plain bullets', () => {
  const lines = parseTodoLines(['# Todo List', '', '- [ ] Call Sam', '  - [x] Check expiry  ', '- plain bullet', '```', '- [ ] in a fence', '```',
    'Select a checkbox to complete or reopen a task.', '* [X] Pay rent', '- [ ]'].join('\n'))
  assert.deepEqual(lines.map((line) => [line.text, line.checked]), [['Call Sam', false], ['Check expiry', true], ['Pay rent', true]])
  const content = '# Todo List\n\n- [ ] Call Sam\n'
  assert.equal(content.slice(lines[0].from, lines[0].to), '- [ ] Call Sam')
  assert.deepEqual(parseTodoLines(seedBody).map((line) => line.checked), [false], 'only the starter task in the seed is a todo')
})

test('syncs checkbox lines into todo-list actions', async (context) => {
  const store = await newStore(context)
  assert.deepEqual(syncTodoList(store, '# Todo\n\n- [ ] Call Sam\n- [x] Pay rent\nA sentence that says Call Sam.\n'), { added: 2, completed: 0, reopened: 0, orphaned: 0 })
  const byText = Object.fromEntries(todos(store).map((action) => [action.text, action]))
  assert.equal(byText['Call Sam'].status, 'open')
  assert.equal(byText['Pay rent'].status, 'done')
  assert.equal(byText['Call Sam'].origin, 'todo-list')
  assert.equal(byText['Call Sam'].anchor.noteId, TODO_LIST_ID)
  assert.deepEqual(syncTodoList(store, '# Todo\n\n- [ ] Call Sam\n- [x] Pay rent\n'), { added: 0, completed: 0, reopened: 0, orphaned: 0 }, 'idempotent')
  assert.equal(todos(store).length, 2)
})

test('checking and unchecking a box moves the action both ways', async (context) => {
  const store = await newStore(context)
  syncTodoList(store, '- [ ] Call Sam\n- [ ] Email Pat\n')
  const sam = todos(store).find((action) => action.text === 'Call Sam')
  assert.equal(syncTodoList(store, '- [x] Call Sam\n- [ ] Email Pat\n').completed, 1)
  assert.equal(store.get(sam.id).status, 'done')
  assert.equal(store.get(sam.id).anchor.quote, '- [x] Call Sam')
  assert.equal(syncTodoList(store, 'New intro\n\n- [ ] Call Sam\n- [ ] Email Pat\n').reopened, 1)
  assert.equal(store.get(sam.id).status, 'open')
  assert.equal(todos(store).length, 2, 'a moved and toggled line still matches its action')
  // The other direction: completing in the store does not touch the file content, and the next sync respects the file.
  store.complete(sam.id)
  assert.equal(store.get(sam.id).status, 'done')
})

test('a removed line orphans its action and re-attaches when it returns; letting go stays permanent', async (context) => {
  const store = await newStore(context)
  syncTodoList(store, '- [ ] Call Sam\n- [ ] Email Pat\n- [ ] Book room\n')
  const [sam, pat, room] = ['Call Sam', 'Email Pat', 'Book room'].map((text) => todos(store).find((action) => action.text === text))
  store.letGo(room.id)
  assert.equal(syncTodoList(store, '- [ ] Email Pat\n- [ ] Book room\n').orphaned, 1)
  assert.equal(store.get(sam.id).anchor.orphaned, true)
  assert.equal(store.get(sam.id).status, 'open', 'never deleted')
  assert.equal(store.get(pat.id).anchor.orphaned, false)
  assert.equal(store.get(room.id).status, 'let-go', 'an unchecked line cannot revive a dismissed action')
  syncTodoList(store, '- [ ] Call Sam\n- [ ] Email Pat\n- [ ] Book room\n')
  assert.equal(store.get(sam.id).anchor.orphaned, false)
  assert.equal(todos(store).length, 3)
})

test('duplicate lines map one to one and todo lines are never suppressed', async (context) => {
  const store = await newStore(context)
  syncTodoList(store, '- [ ] Water plants\n- [ ] Water plants\n')
  assert.equal(todos(store).length, 2)
  store.muteKind('task')
  assert.equal(syncTodoList(store, '- [ ] Water plants\n- [ ] Water plants\n- [ ] Pay rent\n').added, 1)
})
