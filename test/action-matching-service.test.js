import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime } from '../server/app.js'
import { PROMPT_VERSION } from '../server/actions/extraction/pipeline.js'
import { MATCHING_VERSION } from '../server/actions/matching/apply.js'
import { createActionService, hashContent } from '../server/actions/service.js'
import { createActionStore } from '../server/actions/store.js'

const sentenceOf = (messages) => messages.at(-1).content.match(/<sentence>([\s\S]*?)<\/sentence>/)?.[1]
const PEOPLE = ['Anna', 'Kari', 'Harper']

// A stand-in for Gemma: every sentence with a task verb is an action of "me"; the yes/no question answers from `verdict`.
function fakeMlx({ verdict = () => false } = {}) {
  const calls = { extract: 0, ask: [] }
  return {
    calls,
    status: async () => ({ available: true, models: [{ id: 'gemma4', purpose: 'generation', selected: true, installed: true }] }),
    isBusy: () => false,
    generate: async (messages) => {
      const sentence = sentenceOf(messages)
      const task = messages.at(-1).content.match(/<task>([\s\S]*?)<\/task>/)?.[1]
      if (task !== undefined) {
        calls.ask.push(task)
        return { text: JSON.stringify({ done: verdict(task) }), modelId: 'gemma4' }
      }
      calls.extract += 1
      const text = sentence.replace(/^[\s>*_~-]*(?:\[[ xX]\]\s*)?/, '').trim()
      const action = /\b(send|call|email|renew|order|pay|ring|sende|bestille)\b/i.test(text) && !/\b(sent|called|emailed|paid|ordered)\b/i.test(text)
      const person = PEOPLE.find((name) => text.includes(name)) ?? null
      return { text: JSON.stringify({ is_action: action, actor: action ? 'me' : 'unknown', summary: action ? text.replace(/^(?:I (?:need|have) to|Remember to|Husk å)\s+/i, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase()).replace(/\.$/, '') : '', person, time_phrase: null }), modelId: 'gemma4' }
    },
    embed: async () => { throw new Error('embeddings are not installed') },
  }
}

async function setup(context, { mlx = fakeMlx() } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-matching-service-'))
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: path.join(dataRoot, 'models') }, mlx)
  const store = createActionStore({ filePath: path.join(dataRoot, 'actions.json') })
  runtime.actionStore = store
  const service = createActionService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5, timeZone: 'Europe/Oslo' })
  context.after(async () => { await service.close(); await store.flush(); await fs.rm(dataRoot, { recursive: true, force: true }) })
  const write = async (id, content, at) => {
    const filePath = path.join(runtime.bundleRoot, id)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
    await fs.utimes(filePath, at, at)
    await runtime.reindexBundle()
  }
  const process = async (id, content, at) => { await write(id, content, new Date(at)); service.enqueue(id); await service.idle() }
  return { runtime, store, service, mlx, process, write }
}

const open = (store) => store.list({ includeClosed: true }).map((action) => `${action.status}:${action.text}`)

test('a restated commitment in another note is merged into the open action, not duplicated', async (context) => {
  const { store, service, process } = await setup(context)
  await process('/plan.md', '- [ ] Send the budget to Anna\n', '2026-11-09T09:00:00Z')
  await process('/sync.md', 'We went through the numbers.\nI need to send the budget to Anna.\n', '2026-11-11T14:00:00Z')
  const [action, ...rest] = store.list()
  assert.equal(rest.length, 0)
  assert.equal(action.anchor.noteId, '/plan.md')
  assert.deepEqual(action.anchors.map((anchor) => anchor.noteId), ['/sync.md'])
  assert.equal(action.history.at(-1).reason, 'repeat')
  assert.equal(service.status().repeatsMerged, 1)
  store.undo(action.id)
  assert.equal(store.get(action.id).anchors.length, 0, 'the merge is undoable')
})

test('reprocessing a note does not merge the same passage twice', async (context) => {
  const { store, process } = await setup(context)
  await process('/plan.md', '- [ ] Send the budget to Anna\n', '2026-11-09T09:00:00Z')
  await process('/sync.md', 'I need to send the budget to Anna.\n', '2026-11-11T14:00:00Z')
  await process('/sync.md', 'I need to send the budget to Anna.\nElena shares the forecast.\n', '2026-11-11T15:00:00Z')
  const [action] = store.list()
  assert.equal(store.list().length, 1)
  assert.equal(action.anchors.length, 1)
  assert.equal(action.history.filter((entry) => entry.reason === 'repeat').length, 1)
})

test('a clear completion in a later note finishes the action with undo, and an undone one stays open', async (context) => {
  const { store, service, process } = await setup(context)
  await process('/plan.md', '- [ ] Send the budget to Anna\n', '2026-11-09T09:00:00Z')
  await process('/journal.md', 'Sent the budget to Anna this morning.\n', '2026-11-11T09:00:00Z')
  const [done] = store.list({ includeClosed: true })
  assert.equal(done.status, 'done')
  assert.equal(done.completion.noteId, '/journal.md')
  assert.equal(done.completion.quote, 'Sent the budget to Anna this morning.')
  assert.equal(done.history.at(-1).by, 'system')
  assert.equal(service.status().autoCompleted, 1)
  store.undo(done.id)
  await process('/journal.md', 'Sent the budget to Anna this morning.\nNext: the audit.\n', '2026-11-11T10:00:00Z')
  assert.equal(store.get(done.id).status, 'open', 'the same evidence does not complete it again')
  assert.equal(store.get(done.id).completionSuggestion, null)
})

test('a probable completion becomes a suggestion that the user can dismiss for good', async (context) => {
  const { store, process } = await setup(context)
  await process('/ship.md', '- [ ] Email the vendor about the delayed shipment\n', '2026-11-09T09:00:00Z')
  await process('/journal.md', 'Emailed the vendor about the shipment and got a reply.\n', '2026-11-11T09:00:00Z')
  const [action] = store.list()
  assert.equal(action.status, 'open')
  assert.equal(action.completionSuggestion.noteId, '/journal.md')
  store.dismissCompletion(action.id)
  await process('/journal.md', 'Emailed the vendor about the shipment and got a reply.\nIt should arrive next week.\n', '2026-11-11T10:00:00Z')
  assert.equal(store.get(action.id).completionSuggestion, null)
})

test('completion dated before the action existed does nothing', async (context) => {
  const { store, process } = await setup(context)
  await process('/plan.md', '- [ ] Send the budget to Anna\n', '2026-11-09T09:00:00Z')
  await process('/old.md', 'Sent the budget to Anna last week.\n', '2026-11-02T09:00:00Z')
  assert.equal(store.list()[0].status, 'open')
})

test('what the user let go of or rejected stays closed even when worded differently', async (context) => {
  const { store, process } = await setup(context)
  await process('/ideas.md', '- [ ] Order new business cards\n- [ ] Call Kari\n', '2026-11-03T09:00:00Z')
  for (const action of store.list()) store.letGo(action.id)
  await process('/later.md', 'Remember to order new business cards.\nI have to call Kari.\n', '2026-11-10T09:00:00Z')
  assert.deepEqual(store.list(), [], 'nothing came back')
  assert.deepEqual(open(store).sort(), ['let-go:Call Kari', 'let-go:Order new business cards'])
  await process('/sent.md', 'Ordered new business cards.\n', '2026-11-11T09:00:00Z')
  assert.equal(store.list({ includeClosed: true }).filter((action) => action.status === 'done').length, 0, 'a completion never reopens or finishes a closed action')
})

test('a recurring task that was finished starts a new action in another note', async (context) => {
  const { store, process } = await setup(context)
  await process('/october.md', '- [ ] Send the timesheet to Harper\n', '2026-10-05T09:00:00Z')
  store.complete(store.list()[0].id)
  await process('/november.md', '- [ ] Send the timesheet to Harper\n', '2026-11-09T09:00:00Z')
  assert.deepEqual(open(store), ['done:Send the timesheet to Harper', 'open:Send the timesheet to Harper'])
  assert.equal(store.list()[0].anchors.length, 0)
})

test('the middle band asks one yes/no question, and a failed or negative answer reports nothing', async (context) => {
  for (const [verdict, expected] of [[() => true, 'Ordered the office desks.'], [() => false, null]]) {
    const mlx = fakeMlx({ verdict })
    const { store, process } = await setup(context, { mlx })
    await process('/office.md', '- [ ] Order the office chairs\n', '2026-11-09T09:00:00Z')
    await process('/journal.md', 'Ordered the office desks.\n', '2026-11-11T09:00:00Z')
    assert.equal(mlx.calls.ask.length, 1)
    assert.equal(store.list()[0].completionSuggestion?.quote ?? null, expected)
    assert.equal(store.list()[0].status, 'open', 'a model answer never completes on its own')
  }
  const broken = fakeMlx()
  const original = broken.generate
  broken.generate = async (messages, options) => { if (messages.at(-1).content.includes('<task>')) throw new Error('worker crashed'); return original(messages, options) }
  const { store, process } = await setup(context, { mlx: broken })
  await process('/office.md', '- [ ] Order the office chairs\n', '2026-11-09T09:00:00Z')
  await process('/journal.md', 'Ordered the office desks.\n', '2026-11-11T09:00:00Z')
  assert.equal(store.list()[0].completionSuggestion, null)
})

test('an unrelated completion sentence and other people\'s work never touch an action', async (context) => {
  const { store, process } = await setup(context)
  await process('/plan.md', '- [ ] Send the budget to Anna\n- [ ] Call Kari\n', '2026-11-09T09:00:00Z')
  await process('/journal.md', 'Sent the signed contract to Anna.\nI haven\'t called Kari yet.\nHarper called Kari about it.\n', '2026-11-11T09:00:00Z')
  assert.deepEqual(open(store).sort(), ['open:Call Kari', 'open:Send the budget to Anna'])
  assert.ok(store.list().every((action) => !action.completionSuggestion))
})

test('notes processed before matching existed are matched again without calling the model', async (context) => {
  const mlx = fakeMlx()
  const { store, runtime, process, write } = await setup(context, { mlx })
  await process('/plan.md', '- [ ] Send the budget to Anna\n', '2026-11-09T09:00:00Z')
  const content = 'Sent the budget to Anna this morning.\n'
  await write('/journal.md', content, new Date('2026-11-11T09:00:00Z'))
  const record = (await runtime.readRecords()).find((entry) => entry.id === '/journal.md')
  // The note was extracted by an older build: current for extraction, never matched.
  await store.setNoteState('/journal.md', { contentHash: hashContent(record.content), promptVersion: PROMPT_VERSION })
  const before = mlx.calls.extract
  const service = createActionService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5, timeZone: 'Europe/Oslo' })
  context.after(() => service.close())
  service.enqueue('/journal.md')
  await service.idle()
  assert.equal(mlx.calls.extract, before, 'no extraction call')
  assert.equal(store.list({ includeClosed: true })[0].status, 'done')
  assert.equal(store.noteState('/journal.md').matchingVersion, MATCHING_VERSION)
  service.enqueue('/journal.md')
  await service.idle()
  assert.equal(service.status().skipped, 1, 'now current')
})
