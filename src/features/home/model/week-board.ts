import type { ActionDue, ActionItem } from "../../../domain/types.ts";
import { addDays, daysBetween, localDate, shortDate, startOfWeek, weekdayName } from "./home-time.ts";
import {
  buildTimeColumns,
  entryDateLabel,
  HORIZON_CAP_DAYS,
  HORIZON_TARGET,
  MAX_BUDGET,
  type ColumnSpec,
} from "./time-buckets.ts";

export type BoardPlacement =
  | "today"
  | "earlier"
  | "day"
  | "window"
  | "later"
  | "to-confirm"
  | "loose"
  | "waiting"
  | "faded";

export type BoardEntry = {
  action: ActionItem;
  placement: BoardPlacement;
  suggested: boolean;
  /** The column the card sits in, or the first one a window band covers. Null in the tray. */
  column: string | null;
  /** Finished today: kept in the Today column, quietly, until tomorrow. */
  completed: boolean;
  /** "14:00" when the due date has a time. */
  timeLabel: string | null;
  /** "fri 20" or "3 dec" in a column that spans more than a day. */
  dateLabel: string | null;
  /** "3 days" for items waiting on someone else. */
  waitingLabel: string | null;
  /** A snooze that has just run out. */
  reminder: boolean;
  /** Added by background extraction within the last two days and not touched since. */
  recentlyAdded: boolean;
};

export type EarlierGroup = { date: string; label: string; entries: BoardEntry[] };

export type TimeColumn = ColumnSpec & {
  /** Due earlier than today. Only present on the Today column. */
  earlier: EarlierGroup[];
  entries: BoardEntry[];
};

export type WindowBand = {
  key: string;
  label: string;
  /** Indexes of the first and last columns the band spans. */
  from: number;
  to: number;
  entries: BoardEntry[];
};

export type BoardSummary = {
  /** Open items for today, including earlier ones and returning snoozes. */
  today: number;
  /** Open dated items on the next six days and in windows. */
  comingUp: number;
  waiting: number;
  toConfirm: number;
  looseEnds: number;
};

export type WeekBoard = {
  today: string;
  /** Today first, then days, ranges, weeks and months, and Later last. */
  columns: TimeColumn[];
  /** The last date the columns before Later cover. */
  horizon: string;
  bands: WindowBand[];
  toConfirm: BoardEntry[];
  looseEnds: BoardEntry[];
  waiting: BoardEntry[];
  faded: BoardEntry[];
  summary: BoardSummary;
  /** Nothing needs the user at all. A good state. */
  empty: boolean;
};

const RECENT_MS = 48 * 60 * 60 * 1000;

type Range = { start: string; end: string };

export function dueRange(due: ActionDue | null): Range | null {
  if (!due) return null;
  if ("window" in due) return { start: due.window.start, end: due.window.end };
  return { start: due.date, end: due.date };
}

const isWindow = (action: ActionItem): boolean => Boolean(action.due && "window" in action.due);
const dueTime = (action: ActionItem): string => (action.due && "date" in action.due ? (action.due.time ?? "") : "");

/** "3 days" or "just now": how long someone else has had it. */
export function waitingText(createdAt: string, now: Date, timeZone: string): string {
  const days = Math.max(0, daysBetween(localDate(new Date(createdAt), timeZone), localDate(now, timeZone)));
  if (days === 0) return "just now";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  return `${Math.floor(days / 7)} weeks`;
}

function isReminder(action: ActionItem, nowMs: number): boolean {
  if (action.status === "snoozed")
    return Boolean(action.snoozedUntil) && Date.parse(action.snoozedUntil as string) <= nowMs;
  // The server presents a lapsed snooze as open; its last history entry still shows the snooze.
  return action.status === "open" && action.history.at(-1)?.to === "snoozed";
}

/** Did the user finish this item during `today`? */
function completedOn(action: ActionItem, today: string, timeZone: string): boolean {
  if (action.status !== "done") return false;
  const last = action.history.at(-1);
  if (!last || last.to !== "done") return false;
  return localDate(new Date(last.at), timeZone) === today;
}

function byTimeThenCreated(left: BoardEntry, right: BoardEntry): number {
  const a = dueTime(left.action);
  const b = dueTime(right.action);
  if (a !== b) return !a ? 1 : !b ? -1 : a < b ? -1 : 1;
  return left.action.createdAt < right.action.createdAt ? -1 : left.action.createdAt > right.action.createdAt ? 1 : 0;
}

function byStartThenTime(left: BoardEntry, right: BoardEntry): number {
  const a = dueRange(left.action.due)?.start ?? "";
  const b = dueRange(right.action.due)?.start ?? "";
  return a === b ? byTimeThenCreated(left, right) : a < b ? -1 : 1;
}

const openFirst = (left: BoardEntry, right: BoardEntry) => Number(left.completed) - Number(right.completed);

function earlierLabel(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === -1) return "from yesterday";
  if (diff > -7) return `from ${weekdayName(date).slice(0, 3)}`;
  return `from ${shortDate(date)}`;
}

function windowLabel(range: Range, today: string): string {
  const thisWeek = startOfWeek(today);
  const sameWeek = (date: string) => startOfWeek(date) === thisWeek;
  const nextWeek = (date: string) => startOfWeek(date) === addDays(thisWeek, 7);
  if (sameWeek(range.start) && sameWeek(range.end)) return "sometime this week";
  if (nextWeek(range.start) && nextWeek(range.end)) return "sometime next week";
  return `sometime ${shortDate(range.start)} to ${shortDate(range.end)}`;
}

type Dated = { entry: BoardEntry; start: string; end: string; window: boolean };

/**
 * Where everything lives on the week storyboard. Pure: actions, the clock, a timezone
 * and the number of columns the pane can hold in; time columns, window bands and the
 * tray out. Columns zoom out to the right when little is due.
 */
export function buildWeekBoard(
  actions: ActionItem[],
  now: Date,
  timeZone: string,
  budget: number = MAX_BUDGET,
  target: number = HORIZON_TARGET,
  capDays: number = HORIZON_CAP_DAYS,
): WeekBoard {
  const today = localDate(now, timeZone);
  const nowMs = now.getTime();
  const todayEntries: BoardEntry[] = [];
  const earlier: BoardEntry[] = [];
  const dated: Dated[] = [];
  const board: WeekBoard = {
    today,
    columns: [],
    horizon: today,
    bands: [],
    toConfirm: [],
    looseEnds: [],
    waiting: [],
    faded: [],
    summary: { today: 0, comingUp: 0, waiting: 0, toConfirm: 0, looseEnds: 0 },
    empty: true,
  };

  for (const action of actions) {
    const reminder = isReminder(action, nowMs);
    const completed = completedOn(action, today, timeZone);
    const range = dueRange(action.due);
    const entry: BoardEntry = {
      action,
      placement: "loose",
      column: null,
      suggested: action.status === "suggested",
      completed,
      timeLabel: dueTime(action) || null,
      dateLabel: null,
      waitingLabel: action.kind === "waiting-on" ? waitingText(action.createdAt, now, timeZone) : null,
      reminder,
      recentlyAdded:
        action.origin === "auto" &&
        action.status === "open" &&
        action.history.length === 0 &&
        nowMs - Date.parse(action.createdAt) < RECENT_MS,
    };

    if (action.status === "faded") board.faded.push({ ...entry, placement: "faded" });
    else if (completed || reminder) todayEntries.push(entry);
    else if (action.status === "done") continue;
    else if (action.status === "snoozed") continue;
    else if (action.status !== "open" && action.status !== "suggested") continue;
    else if (!range) {
      if (entry.suggested) board.toConfirm.push({ ...entry, placement: "to-confirm" });
      else if (action.kind === "waiting-on") board.waiting.push({ ...entry, placement: "waiting" });
      else board.looseEnds.push({ ...entry, placement: "loose" });
    } else if (action.kind === "waiting-on" && !entry.suggested && range.start < today && !isWindow(action))
      // A follow-up date that has passed never nags: it stays with the others being waited on.
      board.waiting.push({ ...entry, placement: "waiting" });
    else if (range.end < today) earlier.push({ ...entry, placement: "earlier" });
    else dated.push({ entry, start: range.start, end: range.end, window: isWindow(action) });
  }

  const dates = [
    ...earlier.map(() => today),
    ...todayEntries.filter((entry) => !entry.completed).map(() => today),
    ...dated.filter((item) => !item.window).map((item) => item.start),
  ];
  const windows = dated.filter((item) => item.window).map((item) => (item.start < today ? today : item.start));
  const columns: TimeColumn[] = buildTimeColumns({ today, dates, windows, budget, target, capDays }).map((spec) => ({
    ...spec,
    earlier: [],
    entries: [],
  }));
  const todayColumn = columns[0];
  const laterColumn = columns[columns.length - 1];
  board.columns = columns;
  board.horizon = columns.at(-2)?.end ?? today;

  const inColumn = (entry: BoardEntry, column: TimeColumn, date: string | null) => {
    const placement = column.kind === "today" ? "today" : column.kind === "later" ? "later" : "day";
    column.entries.push({ ...entry, placement, column: column.id, dateLabel: date ? entryDateLabel(date, column) : null });
  };
  for (const entry of todayEntries) inColumn(entry, todayColumn, null);

  const bandMap = new Map<string, WindowBand>();
  for (const item of dated) {
    if (!item.window) {
      const column = columns.find((candidate) => candidate.end !== null && item.start >= candidate.start && item.start <= candidate.end);
      inColumn(item.entry, column ?? laterColumn, item.start);
      continue;
    }
    const container = columns.find(
      (candidate) => candidate.kind !== "later" && candidate.end !== null && candidate.start <= item.start && item.end <= candidate.end,
    );
    if (container) inColumn(item.entry, container, item.start);
    else if (item.start > board.horizon) inColumn(item.entry, laterColumn, item.start);
    else {
      const overlaps = columns.flatMap((column, index) =>
        item.start <= (column.end ?? "9999-12-31") && item.end >= column.start ? [index] : [],
      );
      const label = windowLabel({ start: item.start, end: item.end }, today);
      const key = `${label}:${overlaps[0]}-${overlaps.at(-1)}`;
      const band = bandMap.get(key) ?? { key, label, from: overlaps[0], to: overlaps.at(-1) as number, entries: [] };
      band.entries.push({ ...item.entry, placement: "window", column: columns[overlaps[0]].id });
      bandMap.set(key, band);
    }
  }

  // Earlier items sit at the top of the Today column, grouped by the day they came from.
  const groups = new Map<string, BoardEntry[]>();
  for (const entry of earlier.sort(byStartThenTime)) {
    const date = dueRange(entry.action.due)?.end ?? today;
    groups.set(date, [...(groups.get(date) ?? []), { ...entry, column: todayColumn.id }]);
  }
  todayColumn.earlier = [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, entries]) => ({ date, label: earlierLabel(date, today), entries }));

  for (const column of columns)
    column.entries.sort(column.kind === "day" || column.kind === "today" ? byTimeThenCreated : byStartThenTime).sort(openFirst);
  board.bands = [...bandMap.values()].sort((left, right) => left.from - right.from || left.to - right.to);
  for (const band of board.bands) band.entries.sort(byTimeThenCreated);
  board.toConfirm.sort(byStartThenTime);
  board.looseEnds.sort((left, right) => (left.action.createdAt < right.action.createdAt ? -1 : 1));
  board.waiting.sort((left, right) => (left.action.createdAt < right.action.createdAt ? -1 : 1));
  board.faded.sort((left, right) => (left.action.touchedAt < right.action.touchedAt ? 1 : -1));

  const placed = [
    ...columns.flatMap((column) => [...column.entries, ...column.earlier.flatMap((group) => group.entries)]),
    ...board.bands.flatMap((band) => band.entries),
  ];
  const counts = (entry: BoardEntry) => !entry.completed && !entry.suggested;
  const todayCards = [...todayColumn.entries, ...todayColumn.earlier.flatMap((group) => group.entries)];
  board.summary = {
    today: todayCards.filter(counts).length,
    comingUp: placed.filter(counts).length - todayCards.filter(counts).length,
    // Waiting items given a follow-up day still count as waiting on others.
    waiting: board.waiting.length + placed.filter((entry) => counts(entry) && entry.action.kind === "waiting-on").length,
    toConfirm: board.toConfirm.length + placed.filter((entry) => entry.suggested).length,
    looseEnds: board.looseEnds.length,
  };
  const { today: todayCount, comingUp, waiting, toConfirm, looseEnds } = board.summary;
  board.empty = todayCount + comingUp + waiting + toConfirm + looseEnds === 0;
  return board;
}

/** Every card in reading order: window bands, the columns (earlier first in Today), then the tray. */
export type BoardGroup = { id: string; entries: BoardEntry[] };

export function boardGroups(board: WeekBoard): BoardGroup[] {
  return [
    ...board.bands.map((band) => ({ id: `band:${band.key}`, entries: band.entries })),
    ...board.columns.map((column) => ({
      id: column.id,
      entries: [...column.earlier.flatMap((group) => group.entries), ...column.entries],
    })),
    { id: "to-confirm", entries: board.toConfirm },
    { id: "loose", entries: board.looseEnds },
    { id: "waiting", entries: board.waiting },
  ].filter((group) => group.entries.length > 0);
}
