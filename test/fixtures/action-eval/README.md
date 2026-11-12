# Action extraction evaluation set

Reference data and tooling for measuring how well Folio finds commitments in notes (issue #18, part of #12). Every stage of the extraction pipeline is scored against the same labelled cases, so detector, prompt and model changes cannot quietly make things worse.

- `cases.json` is the labelled dataset.
- `baseline-<stage>.json` is the saved result a run is compared with (created with `--write-baseline`).
- `scripts/lib/action-eval.js` holds the pure matching, scoring and comparison code and the stage registry.
- `scripts/eval-actions.js` is the CLI; `test/action-eval.test.js` runs the CI checks.

All names and events are fictional. Do not add real user notes, chat attachments or copied files.

## Case format

```jsonc
{
  "id": "en-013",                      // unique; prefix en-/no-/mx- by language
  "language": "en",                    // en | no | mixed
  "source": "note",                    // note | transcript | capture
  "now": "2026-06-17T13:20:00+02:00",  // the instant dates are resolved against
  "timeZone": "Europe/Oslo",
  "content": "…",                      // the Markdown exactly as the stage will see it
  "expected": [
    { "quote": "I'll call Sofia on Monday.", "kind": "my-commitment", "person": "Sofia",
      "due": { "date": "2026-06-22" }, "explicit": true }
  ],
  "completions": [ { "quote": "I sent the proposal to Marcus on Tuesday" } ], // optional
  "tags": ["long", "buried", "deadline"]
}
```

- `quote` must be an exact substring of `content` that occurs exactly once. It identifies the action's segment (the sentence or list item); a prediction counts as a match when its `[from, to)` range overlaps the quote. Quotes within a case must not overlap each other.
- `expected: []` marks a pure negative: the stage must produce nothing for that content.
- `completions` lists every checked `- [x]` item and every clear past-tense "done" sentence (the whole sentence, as the detector segments it). Predictions with `kindHint: 'completion'` are scored against this list (the "Completions" section: precision and recall by the same overlap matching) and are excluded from action scoring, so they never count as action false positives. The completion matching stage (#21) will build on them.
- Transcripts mirror what `server/transcription/segments.js` writes: `[01:23] text` paragraphs, or with speakers `**{{speaker1}}** [01:23]` followed by the turn, with `speaker1:: Speaker 1` variable lines at the top of the note.

## Label conventions

**kind**

| kind | meaning |
| --- | --- |
| `task` | A to-do without a promise to someone: checkboxes, `TODO:`, "need to", "husk å", bare imperatives in a capture, "remember to". |
| `my-commitment` | The author promises or plans to do something: "I'll", "I will", "I promise", "jeg skal", "jeg lovet å". |
| `waiting-on` | The author waits for someone else to deliver: "waiting for", "venter på", or a request addressed to a named person. |
| `follow-up` | The author will check back or continue a thread with someone ("follow up with Lena", "ping her", "følge opp"). |
| `event` | A time-bound occurrence the author attends or must plan around (appointments, meetings, inspections). |

**person** is the other person involved, copied as written in the quote (first name). It is `null` when only a pronoun, or no one, is named. Comparison is case-insensitive.

**explicit** is true only for unchecked checkboxes (`- [ ]`), `TODO:` markers, and clear first-person commitments or obligations that carry a time ("I'll draft the notes by Thursday", "jeg må levere … om to uker"). Everything else is false, including events and untimed "I need to…". This is the label the auto-add bar is measured on.

**Speakers in transcripts.** The app's speaker labels (`**{{speaker1}}**`) do not say which speaker is the note owner, so first-person commitments under a speaker label are still expected as `my-commitment`, but always with `explicit: false`: auto-add must never fire when we cannot tell who "I" is (tag `no-owner`). Unlabelled transcripts treat first person as the owner and follow the normal explicit rule.

**Not expected** (hard negatives): past tense and completions, checked boxes, negation, hypotheticals ("maybe we could", "kanskje"), quoted text and blockquotes, code blocks, questions, other people's tasks that are not the author's commitment or something they wait on, dates that are history, and imperative instructions in reference material such as recipes and how-tos (tag `reference-imperative`).

**Tags** are free-form but keep to the existing vocabulary where possible: `checkbox`, `todo-marker`, `deadline`, `waiting`, `follow-up`, `event`, `meeting`, `transcript`, `capture`, `long`, `buried`, `negative`, `past-tense`, `hypothetical`, `negation`, `question`, `quote`, `code`, `other-person`, `history-date`, `reference-imperative`, `completion`, `week-window`, `year-boundary`, `month-boundary`, `dst`, `mixed`.

## Due conventions

`due` is `null`, `{ "date": "YYYY-MM-DD" }`, `{ "date": …, "time": "HH:MM" }` (24-hour, local time in `timeZone`), or `{ "window": { "start": …, "end": … } }`. Comparison is exact.

- Dates are local calendar dates in the case's `timeZone`; `now` carries the offset (CET `+01:00`, CEST `+02:00`).
- Today, "tomorrow", "i morgen": `now`'s local date, plus one for tomorrow.
- A bare weekday ("Friday", "på mandag", "innen onsdag") is the next occurrence strictly after today. Cases never use the weekday of `now` itself.
- "next week" / "neste uke" is the Monday to Sunday window of the following week. "this week" is the current Monday to Sunday (not currently used).
- "end of month" / "slutten av måneden" is `{ window: { start: last day, end: last day } }`.
- "in N days/weeks", "om N dager/uker" add the calendar days to today.
- Explicit dates without a year ("19. november", "5 January") resolve to the next occurrence on or after today.
- Clock times: "3pm", "kl 14", "kl. 9.30", "at 9:30" become `HH:MM`.
- Ambiguous or fuzzy phrases ("before the weekend", "next friday", "innen da") are deliberately avoided or left with `due: null`.

## Adding a case

1. Append to `cases.json` with the next free id and pick a `now` near a calendar edge when it helps (month or year end, DST change).
2. Write the content as users really write it: rough, lower case captures, meeting notes, one buried commitment in a long note. Prefer one idea per case; add a negative next to a positive that looks similar.
3. Copy the quote from the content, label the fields by the conventions above, and work out `due` by hand from `now`.
4. Run `node --test test/action-eval.test.js` (the validation test reports unknown quotes, duplicate quotes and ids, bad dates, and overlapping quotes).

## Running

```sh
npm run eval:actions                       # detector stage: report plus diff against the baseline
npm run eval:actions -- --verbose          # list every false positive, false negative and field mismatch
npm run eval:actions -- --case en-013      # one case, with errors
npm run eval:actions -- --json             # machine-readable metrics and comparison
npm run eval:actions -- --fail-on-regression   # exit 1 when a metric drops by more than 0.02
```

Metrics: precision, recall and F1 on span overlap for actions (completion predictions excluded); completion precision and recall against `completions` (overall, by language, by source, by tag); field accuracy over matched pairs (kind against `kindHint`, person, due, explicit); and **explicit precision**, the fraction of predictions flagged `explicit` that match an expected action that is explicit. Explicit precision is the number that gates auto-add (#12, #17): auto-add must not be turned on by default until it meets the agreed bar.

## Held-out set

`cases-holdout.json` is a blind set (same format, written without seeing the detector). It measures generalisation: how well the rules work on phrasing nobody tuned against.

```sh
npm run eval:actions -- --holdout                    # report and diff against baseline-<stage>-holdout.json
npm run eval:actions -- --holdout --write-baseline   # writes baseline-detector-holdout.json
```

Rules:
- Detector and prompt tuning use only `cases.json`.
- Held-out errors may be read for diagnosis, but must not be fixed by adding phrase-specific rules.
- If the held-out set ends up being used for tuning, move those cases into `cases.json` and write a fresh blind held-out set.
- The held-out baseline is separate (`baseline-<stage>-holdout.json`) and never overwrites the main one. `npm test` gates both.

## Baselines

```sh
npm run eval:actions -- --write-baseline                       # writes baseline-detector.json
npm run eval:actions -- --stage model --write-baseline --model-id <id> --prompt-version <v>
```

A baseline records the stage, the date, the metrics (including completions) (no per-case detail) and optionally `modelId` and `promptVersion`. Update it deliberately, in the same change as the improvement it records, and say why in the commit. `npm test` fails if the detector's recall, precision or explicit precision drops by more than 0.02 against `baseline-detector.json` or `baseline-detector-holdout.json` (the check is skipped while the detector or its baseline does not exist).

## Plugging in the model stage (#17)

`stages.model` in `scripts/lib/action-eval.js` currently throws "not implemented yet (see #17)". To implement it:

1. Make `stages.model.load()` resolve to `predictFn(caseItem)`, which runs the full pipeline (detector candidates, embedding filter, one Gemma call per span, date parser, grounding checks) and returns the **final actions** in the detector's shape: `from`, `to`, `text`, `explicit`, `kindHint` (the derived kind), `person`, `time` (the resolved date). Pass `caseItem.now` and `caseItem.timeZone` through. `scoreStage` then needs no changes.
2. Keep it local only (`local: true`, like `npm run test:e2e:local`): it needs the MLX models and helper, so it must not be imported by `npm test`. Run it with `npm run eval:actions -- --stage model --model-id <id> --prompt-version <v>`.
3. Prompts are versioned files; record the version and model id with `--write-baseline` so later runs print the comparison against the saved model baseline.
4. Routing decisions (auto-add, to confirm, drop) should be reflected in the returned `explicit` flag, so explicit precision measures what would really be auto-added.

The completion and duplicate matching stage (#21) needs its own scorer based on `completions`; register it as `stages.completion`.

## Matching scenarios (issue #21)

`matching-cases.json` (tuning) and `matching-cases-holdout.json` (blind, never tuned on) hold multi-note scenarios in English and Norwegian: a short sequence of notes written over time, replayed through detection, extraction and the repeat and completion matching against a real action store whose clock follows the notes. Run them with `node scripts/eval-actions.js --stage matching [--holdout] [--verbose]`. `--model` replays with the real Gemma extraction, embeddings and yes/no question (local only, needs MLX models).

```jsonc
{
  "id": "t01-en-repeat-budget", "language": "en", "now": "...", "timeZone": "Europe/Oslo", "tags": ["repeat"],
  "notes": [{ "id": "/note.md", "at": "ISO time the note was written", "content": "..." }],   // processed in order; an id may appear again for an edit
  "userActions": [{ "after": 0, "quote": "text of the action", "op": "let-go|reject|done|undo|dismiss-completion" }],  // what the user did after note #after
  "expected": {
    "repeats": [{ "noteId": "...", "quote": "restating passage", "sameAs": { "noteId": "...", "quote": "earlier passage" } }],
    "completions": [{ "noteId": "...", "quote": "evidence", "completes": { "noteId": "...", "quote": "action's passage" }, "auto": true }],
    "stayClosed": [{ "noteId": "...", "quote": "passage that must not create or reopen an action" }],
    "created": [{ "noteId": "...", "quote": "passage that must become its own new action (a recurring task)" }]
  }
}
```

Labels: `auto: true` only when a person would call the match unmistakable (same verb and object, same person, no rival). Quotes must appear exactly once in one version of their note and are matched by containment against the detector's passage. Reported: repeat precision and recall, completion precision and recall (auto or suggestion), auto-completion precision (target 0.97) and recall, wrong resurrections (must be 0) and recurring items that became new actions. The deterministic stage uses detector candidates scoring at least 0.45 as extracted items.
