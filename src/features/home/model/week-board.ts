import type { ActionDue, ActionItem } from "../../../domain/types.ts";
import {
  addDays,
  daysBetween,
  localDate,
  shortDate,
  startOfWeek,
  weekdayIndex,
  weekdayName,
} from "./home-time.ts";

/** Today plus the next six days. */
export const VISIBLE_DAYS = 7;

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
  /** Finished today: kept in the Today column, quietly, until tomorrow. */
  completed: boolean;
  /** "14:00" when the due date has a time. */
  timeLabel: string | null;
  /** "13 Dec" for anything in the Later column. */
  dateLabel: string | null;
  /** "3 days" for items waiting on someone else. */
  waitingLabel: string | null;
  /** A snooze that has just run out. */
  reminder: boolean;
  /** Added by background extraction within the last two days and not touched since. */
  recentlyAdded: boolean;
};

export type EarlierGroup = { date: string; label: string; entries: BoardEntry[] };

export type DayColumn = {
  date: string;
  /** "fri 13", with the month on the first of a month: "tue 1 dec". */
  label: string;
  /** "Friday 13", for announcements and assistive technology. */
  fullLabel: string;
  isToday: boolean;
  weekend: boolean;
  /** Due earlier than today. Only present on the Today column. */
  earlier: EarlierGroup[];
  entries: BoardEntry[];
};

export type WindowBand = {
  key: string;
  label: string;
  /** Zero-based first and last visible day columns the band spans. */
  from: number;
  to: number;
  entries: BoardEntry[];
};

export type LaterColumn = {
  /** The first date the column stands for. */
  date: string;
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
  /** Today first, then the next six days. */
  days: DayColumn[];
  bands: WindowBand[];
  later: LaterColumn;
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

function columnLabel(date: string): { label: string; fullLabel: string } {
  const day = Number(date.slice(8));
  const weekday = weekdayName(date);
  const month = shortDate(date).split(" ")[1].toLowerCase();
  return {
    label: `${weekday.slice(0, 3).toLowerCase()} ${day}${day === 1 ? ` ${month}` : ""}`,
    fullLabel: `${weekday} ${day}`,
  };
}

/** "Friday 13" for the visible week, "Friday 13 Dec" beyond it. Used in announcements. */
export function dayAnnouncement(date: string, today: string): string {
  const offset = daysBetween(today, date);
  if (offset === 0) return "today";
  const day = Number(date.slice(8));
  const base = `${weekdayName(date)} ${day}`;
  return offset > 0 && offset < VISIBLE_DAYS ? base : `${base} ${shortDate(date).split(" ")[1]}`;
}

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

/**
 * Where everything lives on the week storyboard. Pure: actions, the clock and
 * a timezone in; day columns, window bands, the Later column and the tray out.
 */
export function buildWeekBoard(actions: ActionItem[], now: Date, timeZone: string): WeekBoard {
  const today = localDate(now, timeZone);
  const nowMs = now.getTime();
  const lastVisible = addDays(today, VISIBLE_DAYS - 1);

  const days: DayColumn[] = Array.from({ length: VISIBLE_DAYS }, (_, offset) => {
    const date = addDays(today, offset);
    return {
      date,
      ...columnLabel(date),
      isToday: offset === 0,
      weekend: weekdayIndex(date) >= 5,
      earlier: [],
      entries: [],
    };
  });
  const board: WeekBoard = {
    today,
    days,
    bands: [],
    later: { date: addDays(today, VISIBLE_DAYS), entries: [] },
    toConfirm: [],
    looseEnds: [],
    waiting: [],
    faded: [],
    summary: { today: 0, comingUp: 0, waiting: 0, toConfirm: 0, looseEnds: 0 },
    empty: true,
  };
  const earlier: BoardEntry[] = [];
  const bandMap = new Map<string, WindowBand>();

  const place = (entry: BoardEntry, date: string) => {
    const index = daysBetween(today, date);
    if (index < 0) earlier.push({ ...entry, placement: "earlier" });
    else if (index < VISIBLE_DAYS) days[index].entries.push({ ...entry, placement: index === 0 ? "today" : "day" });
    else board.later.entries.push({ ...entry, placement: "later", dateLabel: shortDate(date) });
  };

  for (const action of actions) {
    const reminder = isReminder(action, nowMs);
    const completed = completedOn(action, today, timeZone);
    const range = dueRange(action.due);
    const entry: BoardEntry = {
      action,
      placement: "loose",
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
    else if (completed) days[0].entries.push({ ...entry, placement: "today" });
    else if (action.status === "done") continue;
    else if (action.status === "snoozed" && !reminder) continue;
    else if (action.status !== "open" && action.status !== "snoozed" && action.status !== "suggested") continue;
    else if (reminder) days[0].entries.push({ ...entry, placement: "today" });
    else if (!range) {
      if (entry.suggested) board.toConfirm.push({ ...entry, placement: "to-confirm" });
      else if (action.kind === "waiting-on") board.waiting.push({ ...entry, placement: "waiting" });
      else board.looseEnds.push({ ...entry, placement: "loose" });
    } else if (action.due && "window" in action.due) {
      if (range.end < today) earlier.push({ ...entry, placement: "earlier" });
      else if (range.start > lastVisible)
        board.later.entries.push({ ...entry, placement: "later", dateLabel: shortDate(range.start) });
      else {
        const from = Math.max(0, daysBetween(today, range.start));
        const to = Math.min(VISIBLE_DAYS - 1, daysBetween(today, range.end));
        const label = windowLabel(range, today);
        const key = `${label}:${from}-${to}`;
        const band = bandMap.get(key) ?? { key, label, from, to, entries: [] };
        band.entries.push({ ...entry, placement: "window" });
        bandMap.set(key, band);
      }
    } else if (action.kind === "waiting-on" && !entry.suggested && range.start < today) {
      // A follow-up date that has passed never nags: it stays with the others being waited on.
      board.waiting.push({ ...entry, placement: "waiting" });
    } else place(entry, range.start);
  }

  // Earlier items sit at the top of the Today column, grouped by the day they came from.
  const groups = new Map<string, BoardEntry[]>();
  for (const entry of earlier.sort(byStartThenTime)) {
    const range = dueRange(entry.action.due);
    const date = range?.end ?? today;
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  days[0].earlier = [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, entries]) => ({ date, label: earlierLabel(date, today), entries }));

  for (const day of days) day.entries.sort(byTimeThenCreated).sort(openFirst);
  board.later.entries.sort(byStartThenTime);
  board.later.date = board.later.entries.length
    ? (dueRange(board.later.entries[0].action.due)?.start ?? board.later.date)
    : board.later.date;
  board.bands = [...bandMap.values()].sort((left, right) => left.from - right.from || left.to - right.to);
  for (const band of board.bands) band.entries.sort(byTimeThenCreated);
  board.toConfirm.sort(byStartThenTime);
  board.looseEnds.sort((left, right) => (left.action.createdAt < right.action.createdAt ? -1 : 1));
  board.waiting.sort((left, right) => (left.action.createdAt < right.action.createdAt ? -1 : 1));
  board.faded.sort((left, right) => (left.action.touchedAt < right.action.touchedAt ? 1 : -1));

  const placed = [
    ...days.flatMap((day) => [...day.entries, ...day.earlier.flatMap((group) => group.entries)]),
    ...board.bands.flatMap((band) => band.entries),
    ...board.later.entries,
  ];
  const counts = (entry: BoardEntry) => !entry.completed && !entry.suggested;
  const todayEntries = [...days[0].entries, ...days[0].earlier.flatMap((group) => group.entries)];
  board.summary = {
    today: todayEntries.filter(counts).length,
    comingUp: placed.filter(counts).length - todayEntries.filter(counts).length,
    // Waiting items given a follow-up day still count as waiting on others.
    waiting: board.waiting.length + placed.filter((entry) => counts(entry) && entry.action.kind === "waiting-on").length,
    toConfirm: board.toConfirm.length + placed.filter((entry) => entry.suggested).length,
    looseEnds: board.looseEnds.length,
  };
  const { today: todayCount, comingUp, waiting, toConfirm, looseEnds } = board.summary;
  board.empty = todayCount + comingUp + waiting + toConfirm + looseEnds === 0;
  return board;
}

/** Every card in reading order: Today (earlier first), the days, Later, then the tray. */
export type BoardGroup = { id: string; entries: BoardEntry[] };

export function boardGroups(board: WeekBoard): BoardGroup[] {
  return [
    ...board.bands.map((band) => ({ id: `band:${band.key}`, entries: band.entries })),
    ...board.days.map((day) => ({
      id: `day:${day.date}`,
      entries: [...day.earlier.flatMap((group) => group.entries), ...day.entries],
    })),
    { id: "later", entries: board.later.entries },
    { id: "to-confirm", entries: board.toConfirm },
    { id: "loose", entries: board.looseEnds },
    { id: "waiting", entries: board.waiting },
  ].filter((group) => group.entries.length > 0);
}
