import assert from 'node:assert/strict'
import test from 'node:test'

import { segmentText } from '../server/actions/segments.js'

const view = (content) => segmentText(content).map(({ text, kind, checked, speaker }) => ({ text, kind, ...(checked !== undefined && { checked }), ...(speaker && { speaker }) }))

const cases = [
  ['plain sentences', 'I will call Anna. Then we talk! Really? Yes.', [
    { text: 'I will call Anna.', kind: 'sentence' }, { text: 'Then we talk!', kind: 'sentence' },
    { text: 'Really?', kind: 'sentence' }, { text: 'Yes.', kind: 'sentence' },
  ]],
  ['checkboxes and lists', '- [ ] Call Anna\n- [x] Send budget\n* plain item\n1. numbered item\n  - [X] nested done', [
    { text: 'Call Anna', kind: 'checkbox', checked: false }, { text: 'Send budget', kind: 'checkbox', checked: true },
    { text: 'plain item', kind: 'list' }, { text: 'numbered item', kind: 'list' }, { text: 'nested done', kind: 'checkbox', checked: true },
  ]],
  ['headings', '## Next steps ##\nSome text', [{ text: 'Next steps', kind: 'heading' }, { text: 'Some text', kind: 'sentence' }]],
  ['English abbreviations', 'Use tools e.g. a hammer, etc. and Dr. Smith agrees. Then go.', [
    { text: 'Use tools e.g. a hammer, etc. and Dr. Smith agrees.', kind: 'sentence' }, { text: 'Then go.', kind: 'sentence' },
  ]],
  ['Norwegian abbreviations and dates', 'Vi møtes kl. 14 f.eks. på kontoret. Husk 20. november og bl.a. rapporten. Ferdig.', [
    { text: 'Vi møtes kl. 14 f.eks. på kontoret.', kind: 'sentence' },
    { text: 'Husk 20. november og bl.a. rapporten.', kind: 'sentence' }, { text: 'Ferdig.', kind: 'sentence' },
  ]],
  ['numeric dates and decimals stay whole', 'Frist 20.11 og versjon 1.2 er klar. Neste.', [
    { text: 'Frist 20.11 og versjon 1.2 er klar.', kind: 'sentence' }, { text: 'Neste.', kind: 'sentence' },
  ]],
  ['initials', 'Ask J. Smith about it. Done.', [{ text: 'Ask J. Smith about it.', kind: 'sentence' }, { text: 'Done.', kind: 'sentence' }]],
  ['frontmatter, fences and quotes are skipped', '---\ntitle: Plan\ntags: [a]\n---\nBefore.\n```js\nsend(it). now.\n```\n> Quoted. Text.\n~~~\nTODO: hidden\n~~~\nAfter.', [
    { text: 'Before.', kind: 'sentence' }, { text: 'After.', kind: 'sentence' },
  ]],
  ['inline code stays as text', 'Run `npm test` before shipping.', [{ text: 'Run `npm test` before shipping.', kind: 'sentence' }]],
  ['each line is its own segment', 'call anna\nbuy milk\n\nbook flights', [
    { text: 'call anna', kind: 'sentence' }, { text: 'buy milk', kind: 'sentence' }, { text: 'book flights', kind: 'sentence' },
  ]],
  ['bold speaker and plain speaker', '**Anna:** I will send it. Thanks.\nBob: Sure thing.\nTODO: buy milk\nNotes: not a speaker', [
    { text: 'I will send it.', kind: 'sentence', speaker: 'Anna' }, { text: 'Thanks.', kind: 'sentence', speaker: 'Anna' },
    { text: 'Sure thing.', kind: 'sentence', speaker: 'Bob' }, { text: 'TODO: buy milk', kind: 'sentence' },
    { text: 'Notes: not a speaker', kind: 'sentence' },
  ]],
  ['timestamped speaker lines', '[00:12] Anna: Let me check.\n[01:02:03] **Ola:** Greit.', [
    { text: 'Let me check.', kind: 'sentence', speaker: 'Anna' }, { text: 'Greit.', kind: 'sentence', speaker: 'Ola' },
  ]],
  ['app transcript with speaker turns', '**{{speaker1}}** [00:05]\nI will send the budget. Tomorrow.\n\n[00:40] And call Anna.\n\n**{{speaker2}}** [01:10]\nOkay.\n\n[02:00] Plain follow up.', [
    { text: 'I will send the budget.', kind: 'sentence', speaker: 'speaker1' }, { text: 'Tomorrow.', kind: 'sentence', speaker: 'speaker1' },
    { text: 'And call Anna.', kind: 'sentence', speaker: 'speaker1' }, { text: 'Okay.', kind: 'sentence', speaker: 'speaker2' },
    { text: 'Plain follow up.', kind: 'sentence', speaker: 'speaker2' },
  ]],
  ['inline timestamps are not part of the text', '[00:03] Thanks all. [00:09] We start now.', [
    { text: 'Thanks all.', kind: 'sentence' }, { text: 'We start now.', kind: 'sentence' },
  ]],
  ['app transcript without speakers', '[00:05] First part.\n\n[00:40] Second part.', [
    { text: 'First part.', kind: 'sentence' }, { text: 'Second part.', kind: 'sentence' },
  ]],
  ['unlabelled paragraph after a speaker turn drops the speaker', '**{{speaker1}}** [00:05]\nHello.\n\nBack to notes.', [
    { text: 'Hello.', kind: 'sentence', speaker: 'speaker1' }, { text: 'Back to notes.', kind: 'sentence' },
  ]],
]

for (const [name, content, expected] of cases) {
  test(`segments ${name}`, () => {
    assert.deepEqual(view(content), expected)
  })
}

test('offsets point at the segment content in the original text, including CRLF', () => {
  const content = '---\r\ntitle: x\r\n---\r\n# Plan\r\n- [ ] Call Anna kl. 14\r\n**Anna:** Sure. Later.\r\n[00:12] Bob: ok\r\n'
  const segments = segmentText(content)
  assert.equal(segments.length, 5)
  for (const segment of segments) {
    assert.equal(content.slice(segment.from, segment.to), segment.text)
    assert.ok(segment.from < segment.to)
  }
  assert.equal(segments[1].kind, "checkbox")
})

test('empty and whitespace-only input yields no segments', () => {
  assert.deepEqual(segmentText(''), [])
  assert.deepEqual(segmentText('\n  \n---\n'), [])
  assert.deepEqual(segmentText('- [ ]'), [])
})

test('unterminated code fences swallow the rest of the note', () => {
  assert.deepEqual(view('Keep.\n```\nTODO: nope\nstill code'), [{ text: 'Keep.', kind: 'sentence' }])
})

test('segmentation of a 2,000 word note stays fast', () => {
  const text = 'I will send the budget to Anna e.g. tomorrow at 10.30. Then we review it. '.repeat(250)
  segmentText(text)
  const started = performance.now()
  segmentText(text)
  assert.ok(performance.now() - started < 50)
})
