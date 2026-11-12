import { describe, expect, it } from "vitest";
import type { ActionItem } from "../../src/domain/types.ts";
import { neighbourId, successorId } from "../../src/features/home/model/board-focus.ts";
import { moveForDrop, moveForKey, targetForColumn } from "../../src/features/home/model/board-moves.ts";
import { homeGreeting, partOfDay } from "../../src/features/home/model/home-greeting.ts";
import { toastLabel } from "../../src/features/home/model/action-mutations.ts";
import { addDays, daysBetween, weekdayIndex } from "../../src/features/home/model/home-time.ts";
import {
  buildTimeColumns,
  dayAnnouncement,
  HORIZON_CAP_DAYS,
  HORIZON_TARGET,
  TIMELINE_BUDGET,
  type ColumnSpec,
} from "../../src/features/home/model/time-buckets.ts";
import {
  buildWeekBoard,
  dueRange,
  type BoardEntry,
  type TimeColumn,
  type WeekBoard,
} from "../../src/features/home/model/week-board.ts";

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

/** Eight dated items across the first week: a busy week, so every day keeps its own column. */
const busy = () =>
  Array.from({ length: 8 }, (_, index) => action({ id: `fill${index}`, due: { date: addDays("2026-11-12", index % 7) } }));
const real = (entries: BoardEntry[]) => ids(entries).filter((id) => !id.startsWith("fill"));
const column = (board: WeekBoard, date: string) =>
  board.columns.find((candidate) => date >= candidate.start && date <= (candidate.end ?? "9999-12-31")) as TimeColumn;
const labels = (board: WeekBoard) => board.columns.map((candidate) => candidate.label);

describe("week board columns", () => {
  it("lays out a busy week as today and six single days, across a week boundary", () => {
    const board = build(busy());
    expect(labels(board)).toEqual(["thu 12", "fri 13", "sat 14", "sun 15", "mon 16", "tue 17", "wed 18", "later"]);
    expect(board.columns.map((candidate) => candidate.kind)).toEqual([
      "today", "day", "day", "day", "day", "day", "day", "later",
    ]);
    expect(board.columns.map((candidate) => candidate.weekend)).toEqual([false, false, true, true, false, false, false, false]);
    expect(board.columns[0]).toMatchObject({ isToday: true, fullLabel: "Thursday 12" });
    expect(board.horizon).toBe("2026-11-18");
    expect(board.columns.at(-1)?.start).toBe("2026-11-19");
  });

  it("puts the month on the first of a month", () => {
    const now = new Date("2026-11-27T10:00:00Z");
    const fill = Array.from({ length: 8 }, (_, index) => action({ id: `fill${index}`, due: { date: addDays("2026-11-27", index % 7) } }));
    expect(labels(build(fill, now))).toEqual(["fri 27", "sat 28", "sun 29", "mon 30", "tue 1 dec", "wed 2", "thu 3", "later"]);
  });

  it("places dated items in their column, with the time kept for the card", () => {
    const today = action({ id: "today", due: { date: "2026-11-12", time: "14:00" } });
    const early = action({ id: "early", due: { date: "2026-11-12", time: "08:30" } });
    const friday = action({ id: "fri", due: { date: "2026-11-13" } });
    const wednesday = action({ id: "wed", due: { date: "2026-11-18" } });
    const board = build([wednesday, friday, today, early, ...busy()]);
    expect(real(board.columns[0].entries)).toEqual(["early", "today"]);
    expect(board.columns[0].entries.find((entry) => entry.action.id === "early")).toMatchObject({
      placement: "today",
      timeLabel: "08:30",
    });
    expect(real(column(board, "2026-11-13").entries)).toEqual(["fri"]);
    expect(real(column(board, "2026-11-18").entries)).toEqual(["wed"]);
    expect(column(board, "2026-11-13").entries[0].placement).toBe("day");
    // A single-day column never repeats the date.
    expect(column(board, "2026-11-13").entries.every((entry) => entry.dateLabel === null)).toBe(true);
  });

  it("groups earlier items under a soft 'from' label at the top of today", () => {
    const tuesday = action({ id: "tue", due: { date: "2026-11-10" } });
    const yesterday = action({ id: "yesterday", due: { date: "2026-11-11" } });
    const old = action({ id: "old", due: { date: "2026-10-03" } });
    const ended = action({ id: "ended", due: { window: { start: "2026-11-02", end: "2026-11-08" } } });
    const board = build([yesterday, tuesday, old, ended]);
    expect(board.columns[0].earlier.map((group) => [group.label, ids(group.entries)])).toEqual([
      ["from 3 Oct", ["old"]],
      ["from Sun", ["ended"]],
      ["from Tue", ["tue"]],
      ["from yesterday", ["yesterday"]],
    ]);
    expect(board.columns[0].entries).toHaveLength(0);
    expect(board.columns[0].earlier.map((group) => group.label).join(" ")).not.toMatch(/overdue|late|behind/i);
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
    const board = build([followUp, past, ...busy()]);
    expect(real(column(board, "2026-11-14").entries)).toEqual(["follow"]);
    expect(board.columns.flatMap((candidate) => candidate.entries).find((entry) => entry.action.id === "follow")?.action.kind).toBe("waiting-on");
    expect(ids(board.waiting)).toEqual(["past"]);
    expect(board.columns[0].earlier).toHaveLength(0);
  });

  it("places suggested items where their date says, and flags them", () => {
    const dated = action({ id: "dated", status: "suggested", origin: "suggested", due: { date: "2026-11-13" } });
    const earlier = action({ id: "earlier", status: "suggested", origin: "suggested", due: { date: "2026-11-10" } });
    const undated = action({ id: "undated", status: "suggested", origin: "suggested" });
    const board = build([dated, earlier, undated]);
    expect(column(board, "2026-11-13").entries[0]).toMatchObject({ suggested: true });
    expect(ids(board.columns[0].earlier[0].entries)).toEqual(["earlier"]);
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
    expect(ids(board.columns[0].entries)).toEqual(["open", doneToday.id]);
    expect(board.columns[0].entries[1].completed).toBe(true);
    expect(board.columns[0].earlier).toHaveLength(0);
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
    expect(ids(board.columns[0].entries).sort()).toEqual(["presented", "raw"]);
    expect(board.columns[0].entries.every((entry) => entry.reminder)).toBe(true);
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
    expect(auckland.columns[0].earlier[0].label).toBe("from yesterday");
    expect(ids(auckland.columns[0].entries)).toEqual(["fri"]);
    const la = build([thursday, friday], lateEvening, "America/Los_Angeles");
    expect(ids(la.columns[0].entries)).toEqual(["thu"]);
    expect(ids(column(la, "2026-11-13").entries)).toEqual(["fri"]);
  });

  it("keeps consecutive days across a clock change", () => {
    // Clocks go back in Los Angeles on Sunday 1 November 2026, at 2:00.
    const lateSaturday = new Date("2026-11-01T06:30:00Z");
    const fill = Array.from({ length: 8 }, (_, index) => action({ id: `fill${index}`, due: { date: addDays("2026-10-31", index % 7) } }));
    const board = build([action({ id: "after", due: { date: "2026-11-02" } }), ...fill], lateSaturday, "America/Los_Angeles");
    expect(board.today).toBe("2026-10-31");
    expect(board.columns.slice(0, 7).map((candidate) => candidate.start)).toEqual([
      "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    ]);
    expect(real(column(board, "2026-11-02").entries)).toEqual(["after"]);
    // Oslo goes back on 25 October: the evening before is still Saturday the 24th.
    const oslo = build([], new Date("2026-10-24T21:30:00Z"), "Europe/Oslo");
    expect(oslo.today).toBe("2026-10-24");
    expect(oslo.columns[1].start).toBe("2026-10-25");
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

describe("adaptive time columns", () => {
  const cols = (dates: string[], budget = 8, today = "2026-11-12") =>
    buildTimeColumns({ today, dates, budget });
  const spans = (columns: ColumnSpec[]) => columns.map((candidate) => `${candidate.kind}:${candidate.label}`);

  it("keeps an empty board small and airy, with Today and Later at the ends", () => {
    const columns = cols([]);
    expect(spans(columns)).toEqual(["today:thu 12", "range:fri–sun", "range:mon–wed", "later:later"]);
    expect(columns[0].isToday).toBe(true);
    expect(columns.at(-1)).toMatchObject({ kind: "later", start: "2026-11-19", end: null });
    expect(build([]).empty).toBe(true);
  });

  it("zooms out over a sparse week until the items fit, instead of hiding December in Later", () => {
    const dates = ["2026-11-12", "2026-11-18", "2026-11-26", "2026-12-04", "2026-12-24"];
    const columns = cols(dates);
    // Everything up to the last item is covered by a column; Later starts after it.
    expect(columns.at(-2)?.end).toBe("2026-12-31");
    expect(columns.at(-1)?.start).toBe("2027-01-01");
    expect(columns.length).toBeLessThanOrEqual(8);
    // Day columns give way to weeks and wider ranges to the right.
    const kinds = columns.map((candidate) => candidate.kind);
    expect(kinds[0]).toBe("today");
    expect(kinds).toContain("week");
    // Contiguous with no gaps and no overlaps.
    for (let index = 1; index < columns.length; index += 1)
      expect(columns[index].start).toBe(addDays(columns[index - 1].end as string, 1));
    const board = build(dates.map((date, index) => action({ id: `d${index}`, due: { date } })));
    expect(board.looseEnds).toHaveLength(0);
    expect(ids(board.columns.at(-1)?.entries ?? [])).toEqual([]);
    expect(board.columns.flatMap((candidate) => candidate.entries)).toHaveLength(5);
    expect(board.horizon).toBe("2026-12-31");
  });

  it("labels what it zooms out to in calm lowercase", () => {
    const board = build([action({ id: "far", due: { date: "2027-02-10" } })]);
    const named = labels(board);
    expect(named).toContain("next week");
    expect(named.every((label) => label === label.toLowerCase())).toBe(true);
    expect(board.columns.some((candidate) => candidate.kind === "month" && candidate.label === "january 2027")).toBe(false);
    expect(column(board, "2027-02-10").kind).not.toBe("later");
  });

  it("does not extend past the last item or the cap", () => {
    expect(cols(["2026-11-12", "2026-11-13"]).at(-2)?.end).toBe("2026-11-18");
    const far = cols(["2026-11-12", "2028-01-01"]);
    expect(far.at(-1)?.start <= "2027-06-01").toBe(true);
    expect(HORIZON_TARGET).toBe(8);
    expect(HORIZON_CAP_DAYS).toBe(183);
  });

  it("keeps every day when the week is busy", () => {
    const dates = ["2026-11-12", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
    expect(spans(cols(dates))).toEqual([
      "today:thu 12", "day:fri 13", "day:sat 14", "day:sun 15", "day:mon 16", "day:tue 17", "day:wed 18", "later:later",
    ]);
  });

  it("collapses runs of empty days into one slim range, inside a single Monday to Sunday week", () => {
    const dates = ["2026-11-12", "2026-11-13", "2026-11-18", "2026-11-18", "2026-11-18", "2026-11-18", "2026-11-18", "2026-11-18"];
    const columns = cols(dates);
    expect(spans(columns)).toEqual([
      "today:thu 12", "day:fri 13", "range:sat–sun", "range:mon–tue", "day:wed 18", "later:later",
    ]);
  });

  it("keeps ranges on calendar boundaries across a month end", () => {
    const columns = cols(["2026-11-30", "2026-12-02", "2026-12-20", "2027-01-05"]);
    for (const column of columns.filter((candidate) => candidate.kind === "week")) {
      expect(weekdayIndex(column.start)).toBe(0);
      expect(daysBetween(column.start, column.end as string)).toBe(6);
    }
    for (const column of columns.filter((candidate) => candidate.kind === "month")) {
      expect(column.start.endsWith("-01")).toBe(true);
      expect(addDays(column.end as string, 1).endsWith("-01")).toBe(true);
    }
  });

  it("crosses a year end and names the year", () => {
    const columns = cols(["2026-12-30", "2027-01-20", "2027-03-10"], 8, "2026-12-28");
    expect(columns.at(-2)?.end).toBe("2027-03-31");
    expect(columns.some((column) => column.kind === "month" && column.label === "march 2027")).toBe(true);
    expect(columns.some((column) => column.start === "2027-01-01" || (column.start < "2027-01-01" && (column.end ?? "") >= "2027-01-01"))).toBe(true);
    for (let index = 1; index < columns.length; index += 1)
      expect(columns[index].start).toBe(addDays(columns[index - 1].end as string, 1));
  });

  it("builds the same columns across a clock change, from dates alone", () => {
    const lateSaturday = new Date("2026-11-01T06:30:00Z");
    const first = build([action({ due: { date: "2026-11-20" } })], lateSaturday, "America/Los_Angeles").columns.map((c) => c.id);
    const again = build([action({ due: { date: "2026-11-20" } })], new Date("2026-11-01T05:30:00Z"), "America/Los_Angeles").columns.map((c) => c.id);
    expect(first).toEqual(again);
    expect(first[0]).toBe("today:2026-10-31");
  });

  it("respects a column budget when one is given, keeping Today first and Later last", () => {
    const dates = ["2026-11-12", "2026-11-14", "2026-11-19", "2026-11-26", "2026-12-04", "2026-12-24", "2027-02-02"];
    for (const budget of [4, 5, 6, 7, 8]) {
      const columns = cols(dates, budget);
      expect(columns.length).toBeLessThanOrEqual(budget);
      expect(columns[0].kind).toBe("today");
      expect(columns.at(-1)?.kind).toBe("later");
    }
    const dense = ["2026-11-12", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
    for (const budget of [4, 5, 6, 7, 8]) expect(cols(dense, budget).length).toBeLessThanOrEqual(budget);
  });

  it("gives the vertical timeline every bucket it needs, merging only empty stretches", () => {
    const dates = ["2026-11-12", "2026-11-14", "2026-11-19", "2026-11-26", "2026-12-04", "2026-12-24", "2027-02-02"];
    const columns = buildTimeColumns({ today: "2026-11-12", dates, budget: TIMELINE_BUDGET });
    for (const date of dates) {
      const home = columns.find((candidate) => date >= candidate.start && date <= (candidate.end ?? "9999-12-31"));
      expect(home?.kind).not.toBe("later");
    }
    expect(columns.length).toBeGreaterThan(8);
  });

  it("puts a window under the bucket that contains it, or where it starts, with no band", () => {
    const nextWeek = action({ id: "inside", due: { window: { start: "2026-11-16", end: "2026-11-22" } } });
    const thisWeek = action({ id: "crossing", due: { window: { start: "2026-11-09", end: "2026-11-15" } } });
    const far = action({ id: "far", due: { window: { start: "2027-03-01", end: "2027-03-05" } } });
    const board = build([...busy(), nextWeek, thisWeek, far]);
    // In a busy week the days stay single, so no bucket holds a whole window: it sits where it starts.
    expect(real(column(board, "2026-11-16").entries)).toEqual(["inside"]);
    expect(real(board.columns[0].entries)).toContain("crossing");
    expect(ids(board.columns.at(-1)?.entries ?? [])).toEqual(["far"]);
    expect("bands" in board).toBe(false);

    // On a sparse board a week column contains the window.
    const sparse = buildWeekBoard([nextWeek, action({ id: "later one", due: { date: "2026-12-10" } })], NOW, "UTC", 6);
    const home = sparse.columns.find((candidate) => candidate.entries.some((entry) => entry.action.id === "inside"));
    expect(home).toBeDefined();
    expect(home?.start <= "2026-11-16" && "2026-11-22" <= (home?.end ?? "")).toBe(true);
  });

  it("sorts cards by date inside a wide column and shows their date, not in single days", () => {
    const board = build([
      action({ id: "b", due: { date: "2026-12-03" } }),
      action({ id: "a", due: { date: "2026-11-24" } }),
      action({ id: "c", due: { date: "2026-12-20" } }),
    ]);
    for (const candidate of board.columns.slice(1, -1)) {
      const starts = candidate.entries.map((entry) => dueRange(entry.action.due)?.start ?? "");
      expect([...starts].sort()).toEqual(starts);
      for (const entry of candidate.entries) {
        if (candidate.kind === "day") expect(entry.dateLabel).toBeNull();
        else expect(entry.dateLabel).toMatch(/^([a-z]{3} \d{1,2}|\d{1,2} [a-z]{3})$/);
      }
    }
    // Beyond a month wide, dates read "3 dec"; closer in, "fri 20".
    const far = build([action({ id: "far", due: { date: "2027-02-10" } })]);
    expect(far.columns.flatMap((candidate) => candidate.entries)[0].dateLabel).toMatch(/^(\d{1,2} [a-z]{3}|[a-z]{3} \d{1,2})$/);
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
  const next = { type: "span", start: "2026-11-16", end: "2026-11-22", label: "next week" } as const;

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

  it("gives a card the window of a range, week or month column it is dropped on", () => {
    expect(moveForDrop(action({ due: { date: "2026-11-13", time: "09:00" } }), next, today)).toEqual({
      mutation: {
        type: "edit",
        patch: { due: { window: { start: "2026-11-16", end: "2026-11-22" } } },
        label: "Moved to next week.",
      },
    });
    const december = { type: "span", start: "2026-12-01", end: "2026-12-31", label: "December" } as const;
    expect(moveForDrop(action(), december, today)?.mutation).toMatchObject({
      patch: { due: { window: { start: "2026-12-01", end: "2026-12-31" } } },
      label: "Moved to December.",
    });
    // Already there: nothing to do.
    const there = action({ due: { window: { start: "2026-11-16", end: "2026-11-22" } } });
    expect(moveForDrop(there, next, today)).toBeNull();
  });

  it("derives the target from the column kind", () => {
    const board = build([action({ due: { date: "2026-11-20" } })], NOW, "UTC", 6);
    const kinds = Object.fromEntries(board.columns.map((candidate) => [candidate.kind, targetForColumn(candidate)]));
    expect(kinds.today).toEqual({ type: "day", date: "2026-11-12" });
    expect(kinds.later).toEqual({ type: "later", date: addDays(board.horizon, 1) });
    const wide = board.columns.find((candidate) => candidate.kind === "week" || candidate.kind === "range") as TimeColumn;
    expect(targetForColumn(wide)).toMatchObject({ type: "span", start: wide.start, end: wide.end, label: wide.fullLabel });
  });

  it("sets a follow-up date on a waiting item without changing its kind", () => {
    const waiting = action({ kind: "waiting-on", person: "Ola" });
    const mutation = moveForDrop(waiting, { type: "day", date: "2026-11-14" }, today)?.mutation;
    expect(mutation).toMatchObject({ type: "edit", patch: { due: { date: "2026-11-14" } } });
    expect(mutation?.type === "edit" ? Object.keys(mutation.patch) : []).toEqual(["due"]);
  });

  it("moves Later to the day after the last column", () => {
    expect(moveForDrop(action(), { type: "later", date: "2026-11-19" }, today)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-19" } },
      label: "Moved to Thursday 19 Nov.",
    });
    const alreadyThere = action({ due: { date: "2026-11-19" } });
    expect(moveForDrop(alreadyThere, { type: "later", date: "2026-11-19" }, today)).toBeNull();
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
    const board = build([action({ due: { date: "2026-12-10" } })], NOW, "UTC", 6);
    expect(board.columns.map((candidate) => candidate.fullLabel)).toContain("next week");
    expect(board.columns.every((candidate) => candidate.fullLabel.length > 0)).toBe(true);
  });
});

describe("keyboard moves", () => {
  const dense = busy();
  const boardWith = (...extra: ActionItem[]) => build([...extra, ...dense]);
  const entryOf = (board: WeekBoard, id: string) =>
    [...board.columns.flatMap((candidate) => [...candidate.entries, ...candidate.earlier.flatMap((group) => group.entries)]), ...board.looseEnds, ...board.waiting].find(
      (entry) => entry.action.id === id,
    ) as BoardEntry;

  it("moves a card to the neighbouring day column, never before today", () => {
    const friday = action({ id: "friday", due: { date: "2026-11-13", time: "09:00" } });
    const board = boardWith(friday);
    expect(moveForKey(entryOf(board, "friday"), "later", board)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-14", time: "09:00" } },
      label: "Moved to Saturday 14.",
    });
    expect(moveForKey(entryOf(board, "friday"), "earlier", board)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-12", time: "09:00" } },
      label: "Moved to today.",
    });
    const today = action({ id: "today", due: { date: "2026-11-12" } });
    const withToday = boardWith(today);
    expect(moveForKey(entryOf(withToday, "today"), "earlier", withToday)).toBeNull();
  });

  it("moves into a week or month column with a window and names the bucket", () => {
    const friday = action({ id: "friday", due: { date: "2026-11-13" } });
    const sparse = buildWeekBoard([friday, action({ due: { date: "2026-12-10" } })], NOW, "UTC", 6);
    const entry = entryOf(sparse, "friday");
    const column = sparse.columns.find((candidate) => candidate.id === entry.column) as TimeColumn;
    const following = sparse.columns[sparse.columns.indexOf(column) + 1];
    const move = moveForKey(entry, "later", sparse);
    expect(move?.mutation).toMatchObject({ type: "edit", label: `Moved to ${following.fullLabel}.` });
    expect(following.kind === "day" || following.kind === "today" ? "date" : "window").toBe(
      move?.mutation.type === "edit" && move.mutation.patch.due && "window" in move.mutation.patch.due ? "window" : "date",
    );
    // The window of a wide column is its own bounds.
    const wideIndex = sparse.columns.findIndex((candidate) => candidate.kind === "week" || candidate.kind === "range");
    const before = sparse.columns[wideIndex - 1];
    const stuck = { ...entry, column: before.id };
    expect(moveForKey(stuck, "later", sparse)?.mutation).toMatchObject({
      patch: { due: { window: { start: sparse.columns[wideIndex].start, end: sparse.columns[wideIndex].end } } },
    });
  });

  it("steps from the last day into Later, and from Later past the dated part to no date", () => {
    const wednesday = action({ id: "wed", due: { date: "2026-11-18" } });
    const board = boardWith(wednesday);
    expect(moveForKey(entryOf(board, "wed"), "later", board)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-19" } },
      label: "Moved to Thursday 19 Nov.",
    });
    const later = action({ id: "later", due: { date: "2026-12-24" } });
    const withLater = boardWith(later);
    expect(moveForKey(entryOf(withLater, "later"), "later", withLater)?.mutation).toEqual({
      type: "edit",
      patch: { due: null },
      label: "Moved to loose ends.",
    });
    expect(moveForKey(entryOf(withLater, "later"), "earlier", withLater)?.mutation).toMatchObject({
      patch: { due: { date: "2026-11-18" } },
    });
  });

  it("starts an earlier item at today, and brings an undated one in from the end of the list", () => {
    const loose = action({ id: "loose" });
    const old = action({ id: "old", due: { date: "2026-11-09" } });
    const board = boardWith(loose, old);
    expect(moveForKey(entryOf(board, "old"), "later", board)?.mutation).toMatchObject({ patch: { due: { date: "2026-11-12" } } });
    expect(moveForKey(entryOf(board, "old"), "earlier", board)).toBeNull();
    // Up from "no date" lands in the last bucket; down has nowhere further to go.
    expect(moveForKey(entryOf(board, "loose"), "earlier", board)?.mutation).toMatchObject({ patch: { due: { date: "2026-11-19" } } });
    expect(moveForKey(entryOf(board, "loose"), "later", board)).toBeNull();
  });

  it("sends a card to no date with Shift+End", () => {
    const friday = action({ id: "friday", due: { date: "2026-11-13" } });
    const board = boardWith(friday, action({ id: "plain" }));
    expect(moveForKey(entryOf(board, "friday"), "loose", board)?.mutation).toMatchObject({
      patch: { due: null },
      label: "Moved to loose ends.",
    });
    expect(moveForKey(entryOf(board, "plain"), "loose", board)).toBeNull();
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

  it("finds where focus should land when a card leaves", () => {
    expect(successorId(board, "b")).toBe("c");
    expect(successorId(board, "d")).toBe("c");
    expect(successorId(build([action({ id: "only" })]), "only")).toBeNull();
  });
});
