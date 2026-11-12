import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createActionStore } from '../server/actions/store.js'

async function setup(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-matching-store-'))
  const filePath = path.join(dir, 'actions.json')
  const clock = { time: new Date('2026-11-09T09:00:00.000Z') }
  let counter = 0
  const make = () => createActionStore({ filePath, now: () => new Date(clock.time), idFactory: () => `a${++counter}` })
  const store = make()
  context.after(async () => { await store.flush(); await fs.rm(dir, { recursive: true, force: true }) })
  return { store, make, clock }
}

const item = (overrides = {}) => ({
  text: 'Send the budget to Anna', kind: 'my-commitment', person: 'Anna', due: null, confidence: 0.9, explicit: true, status: 'open', origin: 'auto',
  anchor: { from: 10, to: 40, quote: '- [ ] Send the budget to Anna' }, signals: [], ...overrides,
})
const later = (overrides = {}) => item({ text: 'I need to send the budget to Anna this week', anchor: { from: 5, to: 50, quote: 'I need to send the budget to Anna this week.' }, ...overrides })

test('mergeRepeat adds a secondary anchor, keeps the primary one and records a system history entry', async (context) => {
  const { store, clock } = await setup(context)
  const { added } = store.addFromExtraction('/a.md', [item()], { noteVersion: 'v1', at: new Date('2026-11-09T09:00:00Z') })
  const [action] = added
  assert.equal(action.sourceAt, '2026-11-09T09:00:00.000Z')
  assert.deepEqual(action.anchors, [])
  clock.time = new Date('2026-11-11T09:00:00.000Z')
  const merged = store.mergeRepeat(action.id, later({ due: { date: '2026-11-13' } }), { noteId: '/b.md', noteVersion: 'v2' })
  assert.equal(merged.anchor.noteId, '/a.md')
  assert.equal(merged.anchors.length, 1)
  assert.equal(merged.anchors[0].noteId, '/b.md')
  assert.equal(merged.anchors[0].quote, 'I need to send the budget to Anna this week.')
  assert.deepEqual(merged.due, { date: '2026-11-13' }, 'an undated action takes the new due date')
  assert.equal(merged.touchedAt, '2026-11-11T09:00:00.000Z')
  assert.deepEqual(merged.history.at(-1), { at: '2026-11-11T09:00:00.000Z', from: 'open', to: 'open', by: 'system', reason: 'repeat', noteId: '/b.md', quoteKey: merged.history.at(-1).quoteKey, previousDue: null })
  assert.equal(store.list({ noteId: '/a.md' }).length, 1)
  assert.equal(store.list().length, 1, 'no duplicate action')
})

test('mergeRepeat is idempotent, refreshes only a later or more specific due and never touches user edits', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item({ due: { window: { start: '2026-11-09', end: '2026-11-15' } } })]).added
  store.mergeRepeat(action.id, later({ due: { date: '2026-11-13' } }), { noteId: '/b.md' })
  assert.deepEqual(store.get(action.id).due, { date: '2026-11-13' }, 'a date inside the window is more specific')
  store.mergeRepeat(action.id, later({ due: { window: { start: '2026-11-09', end: '2026-11-15' } } }), { noteId: '/b.md' })
  assert.equal(store.get(action.id).anchors.length, 1, 'the same passage is not added twice')
  assert.equal(store.get(action.id).history.filter((entry) => entry.reason === 'repeat').length, 1)
  assert.deepEqual(store.get(action.id).due, { date: '2026-11-13' }, 'a vaguer due date does not replace it')
  store.mergeRepeat(action.id, later({ due: { date: '2026-11-14' }, anchor: { from: 1, to: 9, quote: 'Send the budget to Anna on Saturday.' } }), { noteId: '/c.md' })
  assert.deepEqual(store.get(action.id).due, { date: '2026-11-14' }, 'a later date is taken')
  store.update(action.id, { text: 'Budget to Anna' })
  store.mergeRepeat(action.id, later({ due: { date: '2026-11-20' }, anchor: { from: 1, to: 9, quote: 'Send the budget to Anna by the 20th.' } }), { noteId: '/d.md' })
  assert.deepEqual(store.get(action.id).due, { date: '2026-11-14' }, 'edited by the user: due stays')
  assert.equal(store.get(action.id).anchors.length, 3)
})

test('mergeRepeat refuses closed actions, the primary note and merges the user took back', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  assert.equal(store.mergeRepeat(action.id, later(), { noteId: '/a.md' }), null, 'same note')
  store.mergeRepeat(action.id, later(), { noteId: '/b.md' })
  const undone = store.undo(action.id)
  assert.equal(undone.anchors.length, 0, 'undo removes the anchor')
  assert.deepEqual(undone.history, [])
  assert.equal(store.mergeRepeat(action.id, later(), { noteId: '/b.md' }), null, 'a merge the user undid is not repeated')
  store.complete(action.id)
  assert.equal(store.mergeRepeat(action.id, later({ anchor: { from: 1, to: 2, quote: 'Other words.' } }), { noteId: '/c.md' }), null, 'closed actions never take repeats')
})

test('undoing a merge restores the previous due date', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item({ due: { window: { start: '2026-11-09', end: '2026-11-15' } } })]).added
  store.mergeRepeat(action.id, later({ due: { date: '2026-11-13' } }), { noteId: '/b.md' })
  assert.deepEqual(store.undo(action.id).due, { window: { start: '2026-11-09', end: '2026-11-15' } })
})

test('anchors follow their notes when the note is renamed or edited', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  store.mergeRepeat(action.id, later(), { noteId: '/b.md' })
  await store.moveNote('/b.md', '/renamed.md')
  assert.equal(store.get(action.id).anchors[0].noteId, '/renamed.md')
  store.reanchor('/renamed.md', 'Intro line.\nI need to send the budget to Anna this week.\n')
  assert.equal(store.get(action.id).anchors[0].from, 12)
})

test('completeFromEvidence closes the action as the system, keeps the evidence and can be undone', async (context) => {
  const { store, clock } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  clock.time = new Date('2026-11-11T12:00:00.000Z')
  const done = store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent the budget to Anna.', from: 3, to: 27, score: 0.97 })
  assert.equal(done.status, 'done')
  assert.deepEqual(done.completion, { noteId: '/b.md', quote: 'Sent the budget to Anna.', from: 3, to: 27, score: 0.97, at: '2026-11-11T12:00:00.000Z', auto: true })
  assert.equal(done.history.at(-1).by, 'system')
  assert.equal(done.history.at(-1).reason, 'completion')
  assert.equal(store.feedbackLog().length, 0, 'a system change is not feedback from the user')
  const undone = store.undo(action.id)
  assert.equal(undone.status, 'open')
  assert.equal(undone.completion, null)
  assert.equal(store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent the budget to Anna.' }), null, 'the same evidence never completes it again')
  assert.equal(store.suggestCompletion(action.id, { noteId: '/b.md', quote: 'sent the budget to anna' }), null, 'nor suggests it')
  const other = store.completeFromEvidence(action.id, { noteId: '/c.md', quote: 'All sent: the budget to Anna.' })
  assert.equal(other.status, 'done', 'different evidence is still accepted')
})

test('completing a snoozed action by evidence and undoing it brings the snooze back', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  store.snooze(action.id, '2026-12-01T08:00:00.000Z')
  store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent it.' })
  const undone = store.undo(action.id)
  assert.equal(undone.status, 'snoozed')
  assert.equal(undone.snoozedUntil, '2026-12-01T08:00:00.000Z')
})

test('closed actions are never touched by evidence', async (context) => {
  const { store } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  store.letGo(action.id)
  assert.equal(store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent it.' }), null)
  assert.equal(store.suggestCompletion(action.id, { noteId: '/b.md', quote: 'Sent it.' }), null)
  assert.equal(store.get(action.id).status, 'let-go')
  assert.equal(store.openForMatching().length, 0)
})

test('suggestCompletion keeps the status, accept completes it, dismiss suppresses that evidence', async (context) => {
  const { store } = await setup(context)
  const [first, second] = store.addFromExtraction('/a.md', [item(), item({ text: 'Call Kari', person: 'Kari', anchor: { from: 60, to: 70, quote: 'Call Kari' } })]).added
  const suggested = store.suggestCompletion(first.id, { noteId: '/b.md', quote: 'Emailed the budget to Anna.', score: 0.72 })
  assert.equal(suggested.status, 'open')
  assert.equal(suggested.completionSuggestion.quote, 'Emailed the budget to Anna.')
  assert.equal(store.suggestCompletion(first.id, { noteId: '/b.md', quote: 'Emailed the budget to Anna.', score: 0.7 }).completionSuggestion.score, 0.72, 'the same evidence is not replaced')
  assert.equal(store.dismissCompletion(first.id).completionSuggestion, null)
  assert.equal(store.suggestCompletion(first.id, { noteId: '/b.md', quote: 'Emailed the budget to Anna.', score: 0.9 }), null, 'dismissed evidence is not suggested again')
  assert.equal(store.dismissCompletion(first.id).status, 'open', 'dismissing nothing is harmless')

  store.suggestCompletion(second.id, { noteId: '/b.md', quote: 'Spoke to Kari.', score: 0.75 })
  const accepted = store.acceptCompletion(second.id)
  assert.equal(accepted.status, 'done')
  assert.equal(accepted.completionSuggestion, null)
  assert.equal(accepted.completion.auto, false)
  assert.equal(accepted.history.at(-1).by, 'user')
  assert.equal(store.undo(second.id).status, 'open')
  assert.equal(store.suggestCompletion(second.id, { noteId: '/b.md', quote: 'Spoke to Kari.' }), null, 'taking back an accepted suggestion remembers it')
  assert.throws(() => store.acceptCompletion(second.id), /no completion suggestion/)
})

test('bringing back a system-completed action blocks its evidence and a manual completion clears a suggestion', async (context) => {
  const { store } = await setup(context)
  const [action, other] = store.addFromExtraction('/a.md', [item(), item({ text: 'Call Kari', person: 'Kari', anchor: { from: 60, to: 70, quote: 'Call Kari' } })]).added
  store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent the budget to Anna.' })
  store.reopen(action.id)
  assert.equal(store.completeFromEvidence(action.id, { noteId: '/b.md', quote: 'Sent the budget to Anna.' }), null)
  store.suggestCompletion(other.id, { noteId: '/b.md', quote: 'Called Kari.' })
  assert.equal(store.complete(other.id).completionSuggestion, null)
})

test('matching fields survive a reload and older actions get safe defaults', async (context) => {
  const { store, make } = await setup(context)
  const [action] = store.addFromExtraction('/a.md', [item()]).added
  store.mergeRepeat(action.id, later(), { noteId: '/b.md' })
  store.suggestCompletion(action.id, { noteId: '/c.md', quote: 'Emailed it.' })
  await store.flush()
  const reloaded = make()
  await reloaded.load()
  context.after(() => reloaded.flush())
  assert.equal(reloaded.get(action.id).anchors.length, 1)
  assert.equal(reloaded.get(action.id).completionSuggestion.quote, 'Emailed it.')
  const manual = reloaded.addManual({ text: 'Plain' })
  assert.deepEqual([manual.anchors, manual.completion, manual.completionSuggestion], [[], null, null])
  reloaded.setNoteState('/a.md', { contentHash: 'h', promptVersion: 'p', matchingVersion: 1 })
  assert.equal(reloaded.noteState('/a.md').matchingVersion, 1)
  await reloaded.flush()
})
