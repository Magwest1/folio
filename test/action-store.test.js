import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActionStore, fadeStale } from '../server/actions/store.js'
import { quoteKey, textKey } from '../server/actions/fingerprint.js'

async function setup(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-actions-'))
  const filePath = path.join(dir, '.folio', 'actions.json')
  const clock = { time: new Date('2026-05-01T09:00:00.000Z') }
  let counter = 0
  const make = () => createActionStore({ filePath, now: () => new Date(clock.time), idFactory: () => `a${++counter}` })
  const store = make()
  await store.load()
  context.after(async () => { await store.flush(); await fs.rm(dir, { recursive: true, force: true }) })
  return { store, make, filePath, dir, clock }
}

const item = (overrides = {}) => ({
  text: 'Send the budget to Sam', kind: 'my-commitment', person: 'Sam', due: { date: '2026-05-10' },
  confidence: 0.9, explicit: true, status: 'open', origin: 'auto',
  anchor: { from: 10, to: 40, quote: '- [ ] Send the budget to Sam' }, signals: ['checkbox'], ...overrides,
})

test('keys normalise markers, case, whitespace and punctuation', () => {
  assert.equal(quoteKey('- [ ] Call  Sam.'), quoteKey('* [x] call sam'))
  assert.equal(quoteKey('1. Call Sam!\n2) Email Pat'), quoteKey('call sam! email pat'))
  assert.notEqual(textKey('Call Sam'), textKey('Call Sam tomorrow'))
  assert.equal(quoteKey(''), null)
})

test('adds, lists, filters and sorts by due then creation', async (context) => {
  const { store, clock } = await setup(context)
  const later = store.addManual({ text: 'Later', due: { date: '2026-06-01' } })
  clock.time = new Date('2026-05-02T09:00:00.000Z')
  const sooner = store.addManual({ text: 'Sooner', due: { window: { start: '2026-05-04', end: '2026-05-10' } }, person: 'Pat' })
  const undated = store.addManual({ text: 'Undated', kind: 'follow-up' })
  assert.deepEqual(store.list().map((a) => a.id), [sooner.id, later.id, undated.id])
  assert.deepEqual(store.list({ person: 'PAT' }).map((a) => a.id), [sooner.id])
  assert.deepEqual(store.list({ kind: ['follow-up', 'event'] }).map((a) => a.id), [undated.id])
  assert.deepEqual(store.list({ dueFrom: '2026-05-08', dueTo: '2026-05-20' }).map((a) => a.id), [sooner.id])
  assert.deepEqual(store.list({ dueFrom: '2026-05-25' }).map((a) => a.id), [later.id])
  assert.equal(store.get(later.id).origin, 'manual')
  assert.equal(store.get('missing'), null)
  assert.throws(() => store.addManual({ text: '  ' }), { status: 400 })
  assert.throws(() => store.addManual({ text: 'x', due: { date: '2026-13-40' } }), { status: 400 })
  assert.throws(() => store.addManual({ text: 'x', kind: 'chore' }), { status: 400 })
})

test('status transitions keep history, feedback and undo', async (context) => {
  const { store } = await setup(context)
  const { added: [suggested] } = store.addFromExtraction('/n.md', [item({ status: 'suggested', origin: 'suggested', explicit: false })])
  assert.equal(suggested.status, 'suggested')
  assert.equal(store.confirm(suggested.id).status, 'open')
  assert.equal(store.complete(suggested.id).status, 'done')
  assert.equal(store.reopen(suggested.id).status, 'open')
  assert.equal(store.letGo(suggested.id).status, 'let-go')
  assert.deepEqual(store.get(suggested.id).history.map((h) => `${h.from}>${h.to}`),
    ['suggested>open', 'open>done', 'done>open', 'open>let-go'])
  assert.deepEqual(store.feedbackLog().map((f) => f.type), ['accepted', 'completed', 'not-important'])
  assert.equal(store.undo(suggested.id).status, 'open')
  assert.deepEqual(store.feedbackLog().map((f) => f.type), ['accepted', 'completed'])
  assert.equal(store.reject(suggested.id).status, 'rejected')
  assert.equal(store.feedbackLog().at(-1).type, 'not-an-action')
  assert.throws(() => store.snooze(suggested.id, '2026-06-01'), { status: 409 })
  store.undo(suggested.id)
  assert.equal(store.confirm(suggested.id).status, 'open', 'confirming an open action is a no-op')
  assert.throws(() => store.complete('nope'), { status: 404 })
  const fresh = store.addManual({ text: 'Fresh' })
  assert.throws(() => store.undo(fresh.id), { status: 409 })
})

test('snoozed actions report open once their time has passed', async (context) => {
  const { store, clock } = await setup(context)
  const action = store.addManual({ text: 'Water plants' })
  assert.equal(store.snooze(action.id, '2026-05-03').status, 'snoozed')
  assert.deepEqual(store.list({ status: 'open' }), [])
  assert.equal(store.list({ status: 'snoozed' }).length, 1)
  clock.time = new Date('2026-05-04T00:00:00.000Z')
  assert.equal(store.get(action.id).status, 'open')
  assert.equal(store.list({ status: 'open' }).length, 1)
  assert.throws(() => store.snooze(action.id, 'nonsense'), { status: 400 })
  store.snooze(action.id, '2026-05-09')
  assert.equal(store.undo(action.id).status, 'open')
})

test('update accepts a window due, as dropped on a week or month column, and replaces a date with it', async (context) => {
  const { store } = await setup(context)
  const { added: [action] } = store.addFromExtraction('/n.md', [item({ due: { date: '2026-05-20', time: '10:00' } })])
  const moved = store.update(action.id, { due: { window: { start: '2026-05-25', end: '2026-05-31' } } })
  assert.deepEqual(moved.due, { window: { start: '2026-05-25', end: '2026-05-31' } })
  assert.equal(store.list({ dueFrom: '2026-05-26', dueTo: '2026-05-27' }).length, 1)
  assert.throws(() => store.update(action.id, { due: { window: { start: '2026-05-31', end: '2026-05-25' } } }), { status: 400 })
  assert.deepEqual(store.update(action.id, { due: { date: '2026-06-02' } }).due, { date: '2026-06-02' })
})

test('update records an edit, and extraction keeps the edited text', async (context) => {
  const { store } = await setup(context)
  const { added: [action] } = store.addFromExtraction('/n.md', [item()])
  const edited = store.update(action.id, { text: 'Send Sam the revised budget', due: null })
  assert.equal(edited.editedByUser, true)
  assert.equal(store.feedbackLog().at(-1).type, 'edited')
  const again = store.addFromExtraction('/n.md', [item({ confidence: 0.95, due: { date: '2026-05-20' } })], { noteVersion: 'v2' })
  assert.equal(again.added.length, 0)
  assert.equal(again.updated.length, 1)
  const current = store.get(action.id)
  assert.equal(current.text, 'Send Sam the revised budget')
  assert.equal(current.due, null)
  assert.equal(current.confidence, 0.95)
  assert.equal(current.anchor.version, 'v2')
  assert.equal(store.list().length, 1)
  assert.throws(() => store.update(action.id, {}), { status: 400 })
})

test('extraction updates instead of duplicating, and promotes suggestions that become explicit', async (context) => {
  const { store } = await setup(context)
  store.addFromExtraction('/n.md', [item({ status: 'suggested', origin: 'suggested', explicit: false })])
  const result = store.addFromExtraction('/n.md', [item({ anchor: { from: 12, to: 42, quote: '* [ ] send the budget to Sam.' } })])
  assert.equal(result.updated.length, 1)
  assert.equal(result.updated[0].status, 'open')
  assert.equal(store.list({ includeClosed: true }).length, 1)
  assert.equal(store.addFromExtraction('/other.md', [item({ anchor: { from: 0, to: 4, quote: 'other' } })]).added.length, 1,
    'the same text in another note is a separate action')
})

test('dismissal is permanent: it survives re-extraction and a refile', async (context) => {
  const { store } = await setup(context)
  const { added: [action] } = store.addFromExtraction('/inbox/n.md', [item()])
  store.letGo(action.id)
  assert.equal(store.addFromExtraction('/inbox/n.md', [item()]).suppressed.length, 1)
  assert.equal(store.list().length, 0)
  await store.moveNote('/inbox/n.md', '/projects/n.md')
  assert.equal(store.get(action.id).anchor.noteId, '/projects/n.md')
  const refiled = store.addFromExtraction('/projects/n.md', [item({ anchor: { from: 0, to: 5, quote: 'Send the budget to Sam' } })])
  assert.equal(refiled.added.length, 0)
  assert.equal(store.addFromExtraction('/elsewhere.md', [item({ anchor: { from: 3, to: 9, quote: 'other quote' } })]).suppressed.length, 1)
  assert.equal(store.isSuppressed({ noteId: '/x.md', quote: 'different', text: 'send the budget to sam!' }), true)
  assert.equal(store.isSuppressed({ noteId: '/x.md', quote: 'different', text: 'Something else' }), false)
  store.undo(action.id)
  assert.equal(store.isSuppressed({ noteId: '/projects/n.md', quote: 'Send the budget to Sam', text: 'x' }), false)
  store.reject(action.id)
  assert.equal(store.isSuppressed({ noteId: '/projects/n.md', quote: '- [x] send the budget to sam', text: 'zzz' }), true)
  assert.equal(store.isSuppressed({ noteId: '/other.md', quote: '- [x] send the budget to sam', text: 'zzz' }), false)
  store.reopen(action.id)
  store.complete(action.id)
  assert.equal(store.isSuppressed({ noteId: '/projects/n.md', quote: 'Send the budget to Sam', text: 'x' }), true)
})

test('suppresses by source, folder and kind, and keeps not-important and not-an-action distinct', async (context) => {
  const { store } = await setup(context)
  store.suppressSource('/private/')
  store.suppressSource('/notes/one.md')
  store.muteKind('event')
  assert.throws(() => store.suppressSource('relative'), { status: 400 })
  assert.throws(() => store.muteKind('nonsense'), { status: 400 })
  assert.deepEqual(store.suppressions(), { sources: ['/private/', '/notes/one.md'], kinds: ['event'] })
  assert.equal(store.addFromExtraction('/private/deep/x.md', [item()]).suppressed.length, 1)
  assert.equal(store.addFromExtraction('/notes/one.md', [item({ text: 'A' })]).suppressed.length, 1)
  assert.equal(store.addFromExtraction('/notes/two.md', [item({ text: 'B', kind: 'event' })]).suppressed.length, 1)
  assert.equal(store.addFromExtraction('/notes/two.md', [item({ text: 'B', kind: 'task' })]).added.length, 1)
  store.unsuppressSource('/private/')
  store.unmuteKind('event')
  assert.deepEqual(store.suppressions(), { sources: ['/notes/one.md'], kinds: [] })
  const [first, second] = [store.addManual({ text: 'One' }), store.addManual({ text: 'Two' })]
  store.letGo(first.id)
  store.reject(second.id)
  assert.deepEqual(store.feedbackLog().map((f) => f.type), ['not-important', 'not-an-action'])
})

test('feedback keeps the newest 2,000 entries', async (context) => {
  const { store } = await setup(context)
  const action = store.addManual({ text: 'Edit me' })
  for (let index = 0; index < 2005; index += 1) store.update(action.id, { text: `Edit ${index}` })
  const log = store.feedbackLog()
  assert.equal(log.length, 2000)
  assert.equal(log.at(-1).text, 'Edit 2004')
})

test('persists across restarts and serializes concurrent writes', async (context) => {
  const { store, make, filePath } = await setup(context)
  await Promise.all(Array.from({ length: 25 }, (_, index) => Promise.resolve().then(() => store.addManual({ text: `Task ${index}` }))))
  store.suppressSource('/muted/')
  store.setNoteState('/n.md', { contentHash: 'h1', promptVersion: 'p1', processedAt: '2026-05-01T00:00:00.000Z' })
  await store.flush()
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.actions.length, 25)
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['actions.json'], 'no temporary files remain')
  const reopened = make()
  await reopened.load()
  assert.equal(reopened.list().length, 25)
  assert.deepEqual(reopened.suppressions().sources, ['/muted/'])
  assert.deepEqual(reopened.noteState('/n.md'), { contentHash: 'h1', promptVersion: 'p1', processedAt: '2026-05-01T00:00:00.000Z' })
  assert.equal(reopened.noteState('/none.md'), null)
})

test('a corrupt file is preserved and the store starts empty', async (context) => {
  const { store, make, filePath, dir } = await setup(context)
  store.addManual({ text: 'Keep me' })
  await store.flush()
  await fs.writeFile(filePath, '{not json')
  const originalError = console.error
  console.error = () => {}
  context.after(() => { console.error = originalError })
  const recovered = make()
  await recovered.load()
  assert.deepEqual(recovered.list(), [])
  const preserved = (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith('actions.json.corrupt-'))
  assert.equal(preserved.length, 1)
  assert.equal(await fs.readFile(path.join(path.dirname(filePath), preserved[0]), 'utf8'), '{not json')
  recovered.addManual({ text: 'Fresh start' })
  await recovered.flush()
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).actions.length, 1)
  const missing = createActionStore({ filePath: path.join(dir, 'nowhere', 'actions.json') })
  await missing.load()
  assert.deepEqual(missing.list(), [])
})

test('reanchor keeps, shifts, picks the nearest duplicate, fuzzy matches, orphans and re-attaches', async (context) => {
  const { store } = await setup(context)
  const quote = 'Please send the quarterly budget summary to Sam before Friday'
  const original = `Intro\n\n${quote}\n\nOutro`
  const from = original.indexOf(quote)
  const { added: [action] } = store.addFromExtraction('/n.md', [item({ anchor: { from, to: from + quote.length, quote } })])
  assert.deepEqual(store.reanchor('/n.md', original), { moved: [], orphaned: [] })

  const shifted = `New heading\n\nMore words here\n\n${original}`
  assert.deepEqual(store.reanchor('/n.md', shifted, { noteVersion: 'v2' }).moved, [action.id])
  let anchor = store.get(action.id).anchor
  assert.equal(shifted.slice(anchor.from, anchor.to), quote)
  assert.equal(anchor.version, 'v2')

  const duplicated = `ab${shifted}\n\n${'filler '.repeat(50)}\n\n${quote}`
  store.reanchor('/n.md', duplicated)
  anchor = store.get(action.id).anchor
  assert.equal(anchor.from, duplicated.indexOf(quote), 'nearest to the old offset wins')
  assert.notEqual(anchor.from, duplicated.lastIndexOf(quote))

  const edited = 'Intro\n\nplease  SEND the quarterly budget summary to Sam before   Friday!\n\nOutro'
  assert.deepEqual(store.reanchor('/n.md', edited), { moved: [action.id], orphaned: [] })
  anchor = store.get(action.id).anchor
  assert.equal(edited.slice(anchor.from, anchor.to), anchor.quote)
  assert.match(anchor.quote, /^please\s+SEND/)
  assert.equal(anchor.orphaned, false)

  const gone = 'Completely different text about gardening and the weather today.'
  assert.deepEqual(store.reanchor('/n.md', gone), { moved: [], orphaned: [action.id] })
  assert.equal(store.get(action.id).anchor.orphaned, true)
  assert.equal(store.get(action.id).status, 'open', 'orphaned actions are never deleted')

  const restored = `Back again: ${anchor.quote} and more`
  assert.deepEqual(store.reanchor('/n.md', restored).moved, [action.id])
  assert.equal(store.get(action.id).anchor.orphaned, false)
  assert.deepEqual(store.reanchor('/other.md', restored), { moved: [], orphaned: [] })
})

test('fuzzy re-anchoring refuses weak and ambiguous matches', async (context) => {
  const { store } = await setup(context)
  const quote = 'Book the venue for the offsite in March'
  const { added: [action] } = store.addFromExtraction('/n.md', [item({ text: 'Book venue', anchor: { from: 0, to: quote.length, quote } })])
  store.reanchor('/n.md', 'Book a venue for something else entirely in March')
  assert.equal(store.get(action.id).anchor.orphaned, true, 'half the words is not enough')
  store.reanchor('/n.md', 'book the venue for the offsite in march!\n\nbook the venue for the offsite, in March.')
  assert.equal(store.get(action.id).anchor.orphaned, true, 'two equally good candidates are ambiguous')
})

test('moveNote rewrites anchors and suppressed sources, including folders', async (context) => {
  const { store } = await setup(context)
  store.addFromExtraction('/a/one.md', [item()])
  store.addFromExtraction('/a/sub/two.md', [item({ text: 'Two', anchor: { from: 0, to: 3, quote: 'two' } })])
  store.suppressSource('/a/sub/')
  store.suppressSource('/a/one.md')
  store.setNoteState('/a/one.md', { contentHash: 'x' })
  await store.moveNote('/a/', '/b/')
  assert.deepEqual(store.list().map((a) => a.anchor.noteId).sort(), ['/b/one.md', '/b/sub/two.md'])
  assert.deepEqual(store.suppressions().sources.sort(), ['/b/one.md', '/b/sub/'])
  assert.equal(store.noteState('/b/one.md').contentHash, 'x')
  await store.moveNote('/b/one.md', '/c.md')
  assert.equal(store.list({ noteId: '/c.md' }).length, 1)
  assert.ok(store.suppressions().sources.includes('/c.md'))
})

test('forget orphans open actions, keeps closed fingerprints and clears source suppressions', async (context) => {
  const { store } = await setup(context)
  const { added: [open, done] } = store.addFromExtraction('/gone/n.md', [
    item({ text: 'Open one', anchor: { from: 0, to: 8, quote: 'open one' } }),
    item({ text: 'Done one', anchor: { from: 10, to: 18, quote: 'done one' } }),
  ])
  store.complete(done.id)
  store.suppressSource('/gone/n.md')
  store.suppressSource('/gone/')
  store.suppressSource('/keep/')
  await store.forget('/gone/')
  assert.equal(store.get(open.id).anchor.orphaned, true)
  assert.equal(store.get(open.id).status, 'open')
  assert.equal(store.get(done.id).anchor.orphaned, false)
  assert.deepEqual(store.suppressions().sources, ['/keep/'])
  assert.equal(store.addFromExtraction('/gone/n.md', [item({ text: 'Done one', anchor: { from: 0, to: 8, quote: 'done one' } })]).suppressed.length, 1,
    'a re-imported note cannot resurrect a finished action')
})

test('fadeStale quietly fades stale non-explicit open actions only', async (context) => {
  const { store, clock } = await setup(context)
  const make = (overrides) => store.addFromExtraction('/n.md', [item({ explicit: false, due: null, ...overrides })]).added[0]
  const stale = make({ text: 'Stale undated', anchor: { from: 0, to: 1, quote: 'a' } })
  const oldDue = make({ text: 'Old due', due: { date: '2026-05-02' }, anchor: { from: 0, to: 1, quote: 'b' } })
  const futureDue = make({ text: 'Future due', due: { date: '2026-07-01' }, anchor: { from: 0, to: 1, quote: 'c' } })
  const explicit = make({ text: 'Explicit', explicit: true, anchor: { from: 0, to: 1, quote: 'd' } })
  const manual = store.addManual({ text: 'Manual' })
  const touched = make({ text: 'Touched recently', anchor: { from: 0, to: 1, quote: 'e' } })
  clock.time = new Date('2026-05-20T09:00:00.000Z')
  store.update(touched.id, { person: 'Pat' })
  clock.time = new Date('2026-05-30T09:00:00.000Z')
  const faded = fadeStale(store, { now: clock.time })
  assert.deepEqual(faded.sort(), [oldDue.id, stale.id].sort())
  assert.equal(store.get(stale.id).status, 'faded')
  assert.equal(store.get(stale.id).history.at(-1).by, 'system')
  for (const keep of [futureDue, explicit, manual, touched]) assert.equal(store.get(keep.id).status, 'open', keep.text)
  assert.deepEqual(fadeStale(store, { now: clock.time }), [])
  assert.equal(store.feedbackLog().some((f) => f.actionId === stale.id), false, 'fading is not feedback')
  assert.equal(store.addFromExtraction('/n.md', [item({ text: 'Stale undated', explicit: false, anchor: { from: 0, to: 1, quote: 'a' } })]).suppressed.length, 1)
  assert.equal(store.undo(stale.id).status, 'open')
})

test('completed tasks only block the same passage, so recurring tasks return in other notes', async (context) => {
  const { store } = await setup(context)
  const bill = (quote) => item({ text: 'Pay the electricity bill', anchor: { from: 0, to: quote.length, quote } })
  const { added: [done] } = store.addFromExtraction('/october.md', [bill('Pay the electricity bill')])
  store.complete(done.id)
  assert.equal(store.addFromExtraction('/november.md', [bill('- [ ] Pay the electricity bill')]).added.length, 1, 'same text in another note is added again')
  assert.equal(store.addFromExtraction('/october.md', [bill('- [ ] pay the electricity bill.')]).added.length, 0, 'same passage is not duplicated')
  assert.equal(store.list({ includeClosed: true }).length, 2)
  const { added: [dismissed] } = store.addFromExtraction('/other.md', [item({ text: 'Renew passport', anchor: { from: 0, to: 3, quote: 'abc' } })])
  store.letGo(dismissed.id)
  assert.equal(store.addFromExtraction('/another.md', [item({ text: 'Renew passport', anchor: { from: 0, to: 3, quote: 'xyz' } })]).suppressed.length, 1)
  store.reopen(done.id)
  const again = store.addFromExtraction('/october.md', [bill('Pay the electricity bill')])
  assert.equal(again.updated.length, 1, 'a reopened action is updated, not duplicated')
  assert.equal(again.added.length, 0)
})
