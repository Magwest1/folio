import { describe, expect, it } from "vitest";
import type { ActionItem } from "../../src/domain/types.ts";
import { neighbourId, successorId } from "../../src/features/home/model/board-focus.ts";
import { moveForDrop, moveForKey } from "../../src/features/home/model/board-moves.ts";
import { homeGreeting, partOfDay } from "../../src/features/home/model/home-greeting.ts";
import { toastLabel } from "../../src/features/home/model/action-mutations.ts";
import { buildWeekBoard, dayAnnouncement, type BoardEntry } from "../../src/features/home/model/week-board.ts";

// Thursday 12 November 2026.
const NOW = new Date("2026-11-12T10:00:00Z");

let counter = 0;
function action(overrides: Partial<ActionItem> = {}): ActionItem {
  counter += 1;
  return {
    id: `act_${counter}`,
    text: `Thing ${counter}`,
    kind: "task",
    person: null,
    due: null,
    status: "open",
    snoozedUntil: null,
    explicit: false,
    origin: "manual",
    editedByUser: false,
    anchor: null,
    createdAt: "2026-11-01T08:00:00Z",
    updatedAt: "2026-11-01T08:00:00Z",
    touchedAt: "2026-11-01T08:00:00Z",
    history: [],
    ...overrides,
  };
}

const ids = (entries: BoardEntry[]) => entries.map((entry) => entry.action.id);
const build = (actions: ActionItem[], now = NOW, zone = "UTC") => buildWeekBoard(actions, now, zone);

describe("week board columns", () => {
  it("lays out today and the six days after it across a week boundary", () => {
    const board = build([]);
    expect(board.days.map((day) => day.label)).toEqual(["thu 12", "fri 13", "sat 14", "sun 15", "mon 16", "tue 17", "wed 18"]);
    expect(board.days.map((day) => day.weekend)).toEqual([false, false, true, true, false, false, false]);
    expect(board.days[0]).toMatchObject({ isToday: true, fullLabel: "Thursday 12" });
    expect(board.later.date).toBe("2026-11-19");
  });

  it("puts the month on the first of a month", () => {
    const board = build([], new Date("2026-11-27T10:00:00Z"));
    expect(board.days.map((day) => day.label)).toEqual(["fri 27", "sat 28", "sun 29", "mon 30", "tue 1 dec", "wed 2", "thu 3"]);
  });

  it("places dated items in their column, with the time kept for the card", () => {
    const today = action({ id: "today", due: { date: "2026-11-12", time: "14:00" } });
    const early = action({ id: "early", due: { date: "2026-11-12", time: "08:30" } });
    const friday = action({ id: "fri", due: { date: "2026-11-13" } });
    const wednesday = action({ id: "wed", due: { date: "2026-11-18" } });
    const beyond = action({ id: "later", due: { date: "2026-12-24" } });
    const board = build([beyond, wednesday, friday, today, early]);
    expect(ids(board.days[0].entries)).toEqual(["early", "today"]);
    expect(board.days[0].entries[0]).toMatchObject({ placement: "today", timeLabel: "08:30" });
    expect(ids(board.days[1].entries)).toEqual(["fri"]);
    expect(ids(board.days[6].entries)).toEqual(["wed"]);
    expect(board.days[1].entries[0].placement).toBe("day");
    expect(ids(board.later.entries)).toEqual(["later"]);
    expect(board.later.entries[0]).toMatchObject({ placement: "later", dateLabel: "24 Dec" });
    expect(board.later.date).toBe("2026-12-24");
  });

  it("groups earlier items under a soft 'from' label at the top of today", () => {
    const tuesday = action({ id: "tue", due: { date: "2026-11-10" } });
    const yesterday = action({ id: "yesterday", due: { date: "2026-11-11" } });
    const old = action({ id: "old", due: { date: "2026-10-03" } });
    const ended = action({ id: "ended", due: { window: { start: "2026-11-02", end: "2026-11-08" } } });
    const board = build([yesterday, tuesday, old, ended]);
    expect(board.days[0].earlier.map((group) => [group.label, ids(group.entries)])).toEqual([
      ["from 3 Oct", ["old"]],
      ["from Sun", ["ended"]],
      ["from Tue", ["tue"]],
      ["from yesterday", ["yesterday"]],
    ]);
    expect(board.days[0].entries).toHaveLength(0);
    expect(board.days[0].earlier.map((group) => group.label).join(" ")).not.toMatch(/overdue|late|behind/i);
  });

  it("spans windows across the matching columns and sends distant ones to Later", () => {
    const thisWeek = action({ id: "this", due: { window: { start: "2026-11-09", end: "2026-11-15" } } });
    const nextWeek = action({ id: "next", due: { window: { start: "2026-11-16", end: "2026-11-22" } } });
    const farAway = action({ id: "far", due: { window: { start: "2026-11-30", end: "2026-12-04" } } });
    const board = build([nextWeek, thisWeek, farAway]);
    expect(board.bands.map((band) => [band.label, band.from, band.to, ids(band.entries)])).toEqual([
      ["sometime this week", 0, 3, ["this"]],
      ["sometime next week", 4, 6, ["next"]],
    ]);
    expect(ids(board.later.entries)).toEqual(["far"]);
    // A window never also sits in a day column.
    expect(board.days.flatMap((day) => day.entries)).toHaveLength(0);
  });

  it("keeps items that are not placed on a day in the tray", () => {
    const loose = action({ id: "loose" });
    const waiting = action({ id: "waiting", kind: "waiting-on", person: "Ola", createdAt: "2026-11-09T09:00:00Z" });
    const suggested = action({ id: "suggested", status: "suggested", origin: "suggested" });
    const faded = action({ id: "faded", status: "faded" });
    const closed = [action({ status: "done" }), action({ status: "let-go" }), action({ status: "rejected" })];
    const board = build([loose, waiting, suggested, faded, ...closed]);
    expect(ids(board.looseEnds)).toEqual(["loose"]);
    expect(ids(board.waiting)).toEqual(["waiting"]);
    expect(board.waiting[0].waitingLabel).toBe("3 days");
    expect(ids(board.toConfirm)).toEqual(["suggested"]);
    expect(board.toConfirm[0].suggested).toBe(true);
    expect(ids(board.faded)).toEqual(["faded"]);
  });

  it("words how long someone has had a thing", () => {
    const waiting = (createdAt: string) =>
      build([action({ kind: "waiting-on", createdAt })]).waiting[0].waitingLabel;
    expect(waiting("2026-11-12T01:00:00Z")).toBe("just now");
    expect(waiting("2026-11-11T01:00:00Z")).toBe("1 day");
    expect(waiting("2026-10-20T01:00:00Z")).toBe("3 weeks");
  });

  it("shows a follow-up date for a waiting item on its day, and never nags about a past one", () => {
    const followUp = action({ id: "follow", kind: "waiting-on", person: "Ola", due: { date: "2026-11-14" } });
    const past = action({ id: "past", kind: "waiting-on", person: "Per", due: { date: "2026-11-01" } });
    const board = build([followUp, past]);
    expect(ids(board.days[2].entries)).toEqual(["follow"]);
    expect(board.days[2].entries[0].action.kind).toBe("waiting-on");
    expect(ids(board.waiting)).toEqual(["past"]);
    expect(board.days[0].earlier).toHaveLength(0);
  });

  it("places suggested items where their date says, and flags them", () => {
    const dated = action({ id: "dated", status: "suggested", origin: "suggested", due: { date: "2026-11-13" } });
    const earlier = action({ id: "earlier", status: "suggested", origin: "suggested", due: { date: "2026-11-10" } });
    const undated = action({ id: "undated", status: "suggested", origin: "suggested" });
    const board = build([dated, earlier, undated]);
    expect(board.days[1].entries[0]).toMatchObject({ suggested: true });
    expect(ids(board.days[0].earlier[0].entries)).toEqual(["earlier"]);
    expect(ids(board.toConfirm)).toEqual(["undated"]);
    expect(board.summary).toMatchObject({ today: 0, comingUp: 0, toConfirm: 3 });
  });

  it("keeps what was finished today in the Today column until tomorrow", () => {
    const finish = (at: string) =>
      action({ status: "done", due: { date: "2026-11-05" }, history: [{ at, from: "open", to: "done", by: "user" }] });
    const doneToday = finish("2026-11-12T07:00:00Z");
    const doneYesterday = finish("2026-11-11T07:00:00Z");
    const open = action({ id: "open", due: { date: "2026-11-12" } });
    const board = build([doneToday, doneYesterday, open]);
    expect(ids(board.days[0].entries)).toEqual(["open", doneToday.id]);
    expect(board.days[0].entries[1].completed).toBe(true);
    expect(board.days[0].earlier).toHaveLength(0);
    // Quiet progress, not a score: finished items are not counted anywhere.
    expect(board.summary.today).toBe(1);
  });

  it("brings a lapsed snooze back into today and hides a future one", () => {
    const lapsedRaw = action({ id: "raw", status: "snoozed", snoozedUntil: "2026-11-12T08:00:00Z", due: { date: "2026-12-01" } });
    const lapsedPresented = action({
      id: "presented",
      history: [{ at: "2026-11-11T08:00:00Z", from: "open", to: "snoozed", by: "user" }],
    });
    const future = action({ id: "future", status: "snoozed", snoozedUntil: "2026-11-13T09:00:00Z" });
    const reopened = action({
      id: "reopened",
      history: [
        { at: "2026-11-11T08:00:00Z", from: "open", to: "snoozed", by: "user" },
        { at: "2026-11-11T09:00:00Z", from: "snoozed", to: "open", by: "user" },
      ],
    });
    const board = build([lapsedRaw, lapsedPresented, future, reopened]);
    expect(ids(board.days[0].entries).sort()).toEqual(["presented", "raw"]);
    expect(board.days[0].entries.every((entry) => entry.reminder)).toBe(true);
    expect(ids(board.looseEnds)).toEqual(["reopened"]);
  });

  it("marks recent untouched auto-added items", () => {
    const recent = action({ id: "recent", origin: "auto", createdAt: "2026-11-12T06:00:00Z" });
    const stale = action({ id: "stale", origin: "auto", createdAt: "2026-11-08T06:00:00Z" });
    const touched = action({
      id: "touched",
      origin: "auto",
      createdAt: "2026-11-12T06:00:00Z",
      history: [{ at: "2026-11-12T07:00:00Z", from: "open", to: "snoozed", by: "user" }],
    });
    const flags = Object.fromEntries(build([recent, stale, touched]).looseEnds.map((e) => [e.action.id, e.recentlyAdded]));
    expect(flags).toEqual({ recent: true, stale: false });
  });

  it("follows the user's timezone for what today means", () => {
    // 12 Nov 21:00 UTC is already Friday 13 Nov in Auckland and still Thursday in Los Angeles.
    const lateEvening = new Date("2026-11-12T21:00:00Z");
    const thursday = action({ id: "thu", due: { date: "2026-11-12" } });
    const friday = action({ id: "fri", due: { date: "2026-11-13" } });
    const auckland = build([thursday, friday], lateEvening, "Pacific/Auckland");
    expect(auckland.today).toBe("2026-11-13");
    expect(auckland.days[0].earlier[0].label).toBe("from yesterday");
    expect(ids(auckland.days[0].entries)).toEqual(["fri"]);
    const la = build([thursday, friday], lateEvening, "America/Los_Angeles");
    expect(ids(la.days[0].entries)).toEqual(["thu"]);
    expect(ids(la.days[1].entries)).toEqual(["fri"]);
  });

  it("keeps seven consecutive days across a clock change", () => {
    // Clocks go back in Los Angeles on Sunday 1 November 2026, at 2:00.
    const lateSaturday = new Date("2026-11-01T06:30:00Z");
    const board = build([action({ id: "after", due: { date: "2026-11-02" } })], lateSaturday, "America/Los_Angeles");
    expect(board.today).toBe("2026-10-31");
    expect(board.days.map((day) => day.date)).toEqual([
      "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    ]);
    expect(ids(board.days[2].entries)).toEqual(["after"]);
    // Oslo goes back on 25 October: the evening before is still Saturday the 24th.
    const oslo = build([], new Date("2026-10-24T21:30:00Z"), "Europe/Oslo");
    expect(oslo.today).toBe("2026-10-24");
    expect(oslo.days.map((day) => day.date).slice(0, 3)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(build([], new Date("2026-10-24T22:30:00Z"), "Europe/Oslo").today).toBe("2026-10-25");
  });

  it("calls a week with nothing in it empty, and finished or faded items do not change that", () => {
    expect(build([]).empty).toBe(true);
    const quiet = [
      action({ status: "faded" }),
      action({ status: "done", history: [{ at: "2026-11-12T07:00:00Z", from: "open", to: "done", by: "user" }] }),
    ];
    expect(build(quiet).empty).toBe(true);
    expect(build([action()]).empty).toBe(false);
    expect(build([action({ status: "suggested" })]).empty).toBe(false);
  });
});

describe("greeting and summary", () => {
  const greet = (actions: ActionItem[], now = NOW) => homeGreeting(build(actions, now), now, "UTC");
  const due = (count: number) => Array.from({ length: count }, () => action({ due: { date: "2026-11-12" } }));

  it("chooses the opening from the time of day", () => {
    expect([5, 11, 12, 17, 18, 22, 23, 2].map(partOfDay)).toEqual([
      "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night",
    ]);
    expect(greet([], new Date("2026-11-12T08:00:00Z")).headline).toMatch(/^Good morning\./);
    expect(greet([], new Date("2026-11-12T15:00:00Z")).headline).toMatch(/^Good afternoon\./);
    expect(greet([], new Date("2026-11-12T20:00:00Z")).headline).toMatch(/^Good evening\./);
    expect(greet([], new Date("2026-11-12T01:00:00Z")).headline).toMatch(/^Hello\./);
  });

  it("describes the day in a few calm phrasings", () => {
    expect(greet([]).headline).toBe("Good morning. Thursday is wide open.");
    expect(greet(due(2)).headline).toBe("Good morning. Thursday looks fairly light.");
    expect(greet(due(4)).headline).toBe("Good morning. Thursday looks steady.");
    expect(greet(due(8)).headline).toBe("Good morning. Thursday looks full. One thing at a time.");
    for (const count of [0, 1, 3, 9]) expect(greet(due(count)).headline).not.toMatch(/overdue|behind|late|urgent|!/i);
  });

  it("summarises today, waiting and to-confirm in one muted line", () => {
    const waiting = [action({ kind: "waiting-on" }), action({ kind: "waiting-on" })];
    expect(greet([...due(3), ...waiting]).summary).toBe("3 things today · 2 waiting on others");
    expect(greet(due(1)).summary).toBe("1 thing today");
    expect(greet([...due(1), action({ status: "suggested" })]).summary).toBe("1 thing today · 1 to confirm");
    expect(greet([action({ due: { date: "2026-11-14" } }), action({ due: { date: "2026-11-15" } })]).summary).toBe(
      "Nothing today · 2 coming up",
    );
  });

  it("says the week is open when nothing needs the user", () => {
    expect(greet([]).summary).toBe("Nothing needs you right now.");
  });
});

describe("drop target to patch", () => {
  const today = "2026-11-12";

  it("sets the date on a day and keeps the time of day", () => {
    const timed = action({ due: { date: "2026-11-12", time: "14:00" } });
    expect(moveForDrop(timed, { type: "day", date: "2026-11-14" }, today)).toEqual({
      mutation: { type: "edit", patch: { due: { date: "2026-11-14", time: "14:00" } }, label: "Moved to Saturday 14." },
    });
    const plain = action({ due: { date: "2026-11-12" } });
    expect(moveForDrop(plain, { type: "day", date: "2026-11-13" }, today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-13" } },
    });
  });

  it("gives a loose end a date, and replaces a window by a day", () => {
    expect(moveForDrop(action(), { type: "day", date: "2026-11-16" }, today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-16" } },
      label: "Moved to Monday 16.",
    });
    const windowed = action({ due: { window: { start: "2026-11-09", end: "2026-11-15" } } });
    expect(moveForDrop(windowed, { type: "day", date: "2026-11-13" }, today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-13" } },
    });
  });

  it("sets a follow-up date on a waiting item without changing its kind", () => {
    const waiting = action({ kind: "waiting-on", person: "Ola" });
    const mutation = moveForDrop(waiting, { type: "day", date: "2026-11-14" }, today)?.mutation;
    expect(mutation).toMatchObject({ type: "edit", patch: { due: { date: "2026-11-14" } } });
    expect(mutation?.type === "edit" ? Object.keys(mutation.patch) : []).toEqual(["due"]);
  });

  it("moves Later to the day after the last visible column", () => {
    expect(moveForDrop(action(), { type: "later" }, today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-19" } },
      label: "Moved to Thursday 19 Nov.",
    });
    const alreadyThere = action({ due: { date: "2026-11-19" } });
    expect(moveForDrop(alreadyThere, { type: "later" }, today)).toBeNull();
  });

  it("clears the date on the loose-ends tray, only if there is one", () => {
    expect(moveForDrop(action({ due: { date: "2026-11-13" } }), { type: "loose" }, today)?.mutation).toEqual({
      type: "edit",
      patch: { due: null },
      label: "Moved to loose ends.",
    });
    expect(moveForDrop(action(), { type: "loose" }, today)).toBeNull();
  });

  it("lets go on the Let go zone", () => {
    expect(moveForDrop(action({ due: { date: "2026-11-13" } }), { type: "let-go" }, today)).toEqual({
      mutation: { type: "not-important" },
    });
  });

  it("does nothing when a card is dropped on the day it is already on", () => {
    expect(moveForDrop(action({ due: { date: "2026-11-13" } }), { type: "day", date: "2026-11-13" }, today)).toBeNull();
  });

  it("words the move for the live announcement", () => {
    expect(toastLabel({ type: "edit", patch: {}, label: "Moved to Friday 13." })).toBe("Moved to Friday 13.");
    expect(toastLabel({ type: "edit", patch: {} })).toBe("Saved.");
    expect(dayAnnouncement("2026-11-12", today)).toBe("today");
    expect(dayAnnouncement("2026-11-13", today)).toBe("Friday 13");
    expect(dayAnnouncement("2026-12-24", today)).toBe("Thursday 24 Dec");
  });
});

describe("keyboard moves", () => {
  const today = "2026-11-12";

  it("moves a card one day later or earlier, never before today", () => {
    const friday = action({ due: { date: "2026-11-13", time: "09:00" } });
    expect(moveForKey(friday, "later", today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-14", time: "09:00" } },
      label: "Moved to Saturday 14.",
    });
    expect(moveForKey(friday, "earlier", today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-12", time: "09:00" } },
      label: "Moved to today.",
    });
    expect(moveForKey(action({ due: { date: "2026-11-12" } }), "earlier", today)).toBeNull();
    expect(moveForKey(action(), "earlier", today)).toBeNull();
  });

  it("starts a loose end or an earlier item at today", () => {
    expect(moveForKey(action(), "later", today)?.mutation).toMatchObject({ patch: { due: { date: "2026-11-12" } } });
    expect(moveForKey(action({ due: { date: "2026-11-09" } }), "later", today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-12" } },
    });
  });

  it("sends a card to the loose ends with Shift+Down", () => {
    expect(moveForKey(action({ due: { date: "2026-11-13" } }), "loose", today)?.mutation).toMatchObject({
      patch: { due: null },
      label: "Moved to loose ends.",
    });
    expect(moveForKey(action(), "loose", today)).toBeNull();
  });
});

describe("keyboard focus across the board", () => {
  const board = build([
    action({ id: "a", due: { date: "2026-11-12" } }),
    action({ id: "b", due: { date: "2026-11-12" }, createdAt: "2026-11-02T08:00:00Z" }),
    action({ id: "c", due: { date: "2026-11-14" } }),
    action({ id: "d" }),
  ]);

  it("walks every card in reading order with j/k", () => {
    expect(neighbourId(board, null, "next")).toBe("a");
    expect(neighbourId(board, "a", "next")).toBe("b");
    expect(neighbourId(board, "b", "next")).toBe("c");
    expect(neighbourId(board, "c", "next")).toBe("d");
    expect(neighbourId(board, "d", "next")).toBe("d");
    expect(neighbourId(board, "c", "previous")).toBe("b");
    expect(neighbourId(board, "a", "previous")).toBe("a");
  });

  it("jumps between columns with left and right, on the same row", () => {
    expect(neighbourId(board, "b", "right")).toBe("c");
    expect(neighbourId(board, "c", "left")).toBe("a");
    expect(neighbourId(board, "a", "left")).toBe("a");
  });

  it("finds where focus should land when a card leaves", () => {
    expect(successorId(board, "b")).toBe("c");
    expect(successorId(board, "d")).toBe("c");
    expect(successorId(build([action({ id: "only" })]), "only")).toBeNull();
  });
});
