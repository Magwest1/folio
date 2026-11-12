import type { ActionDue, ActionItem } from "../../../domain/types.ts";
import {
  addDays,
  daysBetween,
  localDate,
  shortDate,
  shortWeekdayDate,
  startOfWeek,
  weekdayName,
} from "./home-time.ts";

export type HomeEntry = {
  action: ActionItem;
  /** Calm, human wording such as "Today", "Thursday" or "From Tuesday". */
  dueLabel: string | null;
  /** True once the due date has passed. Only used for a quieter tone, never for alarm styling. */
  passed: boolean;
  /** "since 3 days" for items waiting on someone else. */
  waitingLabel: string | null;
  /** A snooze that has just run out. */
  reminder: boolean;
  /** Added by background extraction within the last two days and not touched since. */
  recentlyAdded: boolean;
};

export type HomeDayGroup = { key: string; label: string; entries: HomeEntry[] };
export type HomeWeekGroup = {
  key: "this-week" | "next-week" | "later";
  label: string;
  days: HomeDayGroup[];
};

export type HomeSections = {
  now: HomeEntry[];
  comingUp: HomeWeekGroup[];
  waiting: HomeEntry[];
  looseEnds: HomeEntry[];
  toConfirm: HomeEntry[];
  faded: HomeEntry[];
};

const RECENT_MS = 48 * 60 * 60 * 1000;

type Range = { start: string; end: string };

export function dueRange(due: ActionDue | null): Range | null {
  if (!due) return null;
  if ("window" in due) return { start: due.window.start, end: due.window.end };
  return { start: due.date, end: due.date };
}

function dayLabel(dateKey: string, today: string): string {
  const diff = daysBetween(today, dateKey);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return weekdayName(dateKey);
  return shortWeekdayDate(dateKey);
}

function passedLabel(dateKey: string, today: string): string {
  const diff = daysBetween(today, dateKey);
  if (diff === -1) return "From yesterday";
  if (diff > -7) return `From ${weekdayName(dateKey)}`;
  return `From ${shortDate(dateKey)}`;
}

/** Wording for a due date relative to today. Never alarming. */
export function dueText(due: ActionDue | null, today: string): string | null {
  const range = dueRange(due);
  if (!due || !range) return null;
  if ("window" in due) {
    if (range.end < today) return passedLabel(range.start, today);
    if (range.start <= today) return "This week";
    return `${shortWeekdayDate(range.start)} to ${shortWeekdayDate(range.end)}`;
  }
  if (range.start < today) return passedLabel(range.start, today);
  const label = dayLabel(range.start, today);
  return due.time ? `${label} ${due.time}` : label;
}

export function waitingText(createdAt: string, now: Date, timeZone: string): string {
  const days = Math.max(0, daysBetween(localDate(new Date(createdAt), timeZone), localDate(now, timeZone)));
  if (days === 0) return "since today";
  if (days === 1) return "since yesterday";
  if (days < 14) return `since ${days} days`;
  return `since ${Math.floor(days / 7)} weeks`;
}

function isReminder(action: ActionItem, nowMs: number): boolean {
  if (action.status === "snoozed")
    return Boolean(action.snoozedUntil) && Date.parse(action.snoozedUntil as string) <= nowMs;
  // The server presents a lapsed snooze as open; its last history entry still shows the snooze.
  return action.status === "open" && action.history.at(-1)?.to === "snoozed";
}

function byDueThenCreated(left: HomeEntry, right: HomeEntry): number {
  const a = dueRange(left.action.due)?.start;
  const b = dueRange(right.action.due)?.start;
  if (a !== b) return !a ? 1 : !b ? -1 : a < b ? -1 : 1;
  const leftTime = "date" in (left.action.due ?? {}) ? (left.action.due as { time?: string }).time ?? "" : "";
  const rightTime = "date" in (right.action.due ?? {}) ? (right.action.due as { time?: string }).time ?? "" : "";
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.action.createdAt < right.action.createdAt ? -1 : left.action.createdAt > right.action.createdAt ? 1 : 0;
}

export function groupHomeActions(actions: ActionItem[], now: Date, timeZone: string): HomeSections {
  const today = localDate(now, timeZone);
  const nowMs = now.getTime();
  const weekStart = startOfWeek(today);
  const thisWeekEnd = addDays(weekStart, 6);
  const nextWeekEnd = addDays(weekStart, 13);

  const sections: HomeSections = { now: [], comingUp: [], waiting: [], looseEnds: [], toConfirm: [], faded: [] };
  const upcoming: { week: HomeWeekGroup["key"]; day: string; ongoing: boolean; entry: HomeEntry }[] = [];

  for (const action of actions) {
    const reminder = isReminder(action, nowMs);
    const range = dueRange(action.due);
    const entry: HomeEntry = {
      action,
      dueLabel: dueText(action.due, today),
      passed: Boolean(range && range.end < today),
      waitingLabel: action.kind === "waiting-on" ? waitingText(action.createdAt, now, timeZone) : null,
      reminder,
      recentlyAdded:
        action.origin === "auto" &&
        action.status === "open" &&
        action.history.length === 0 &&
        nowMs - Date.parse(action.createdAt) < RECENT_MS,
    };

    if (action.status === "suggested") sections.toConfirm.push(entry);
    else if (action.status === "faded") sections.faded.push(entry);
    else if (action.status === "snoozed" && !reminder) continue;
    else if (action.status !== "open" && action.status !== "snoozed") continue;
    else if (reminder) sections.now.push(entry);
    else if (action.kind === "waiting-on") sections.waiting.push(entry);
    else if (!range) sections.looseEnds.push(entry);
    else if (range.end < today || (range.start <= today && range.end >= today && "date" in (action.due ?? {})))
      sections.now.push(entry);
    else if (range.start <= today)
      upcoming.push({ week: "this-week", day: today, ongoing: true, entry });
    else {
      const week = range.start <= thisWeekEnd ? "this-week" : range.start <= nextWeekEnd ? "next-week" : "later";
      upcoming.push({ week, day: range.start, ongoing: false, entry });
    }
  }

  sections.now.sort(byDueThenCreated);
  sections.waiting.sort((left, right) => (left.action.createdAt < right.action.createdAt ? -1 : 1));
  sections.looseEnds.sort(byDueThenCreated);
  sections.toConfirm.sort(byDueThenCreated);
  sections.faded.sort((left, right) => (left.action.touchedAt < right.action.touchedAt ? 1 : -1));

  const weekLabels: Record<HomeWeekGroup["key"], string> = {
    "this-week": "This week",
    "next-week": "Next week",
    later: "Later",
  };
  for (const week of ["this-week", "next-week", "later"] as const) {
    const inWeek = upcoming.filter((item) => item.week === week);
    if (!inWeek.length) continue;
    const days: HomeDayGroup[] = [];
    const ongoing = inWeek.filter((item) => item.ongoing).map((item) => item.entry).sort(byDueThenCreated);
    if (ongoing.length) days.push({ key: "ongoing", label: "Anytime this week", entries: ongoing });
    const dates = [...new Set(inWeek.filter((item) => !item.ongoing).map((item) => item.day))].sort();
    for (const date of dates)
      days.push({
        key: date,
        label: dayLabel(date, today),
        entries: inWeek
          .filter((item) => !item.ongoing && item.day === date)
          .map((item) => item.entry)
          .sort(byDueThenCreated),
      });
    sections.comingUp.push({ key: week, label: weekLabels[week], days });
  }
  return sections;
}

/** Home is "empty" when nothing needs the user. Faded items stay quiet and do not count. */
export function isHomeEmpty(sections: HomeSections): boolean {
  return (
    sections.now.length === 0 &&
    sections.comingUp.length === 0 &&
    sections.waiting.length === 0 &&
    sections.looseEnds.length === 0 &&
    sections.toConfirm.length === 0
  );
}
