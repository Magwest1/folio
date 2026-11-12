/** Calendar helpers for Home. Dates are "YYYY-MM-DD" strings in the user's timezone. */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = formatterFor("UTC");
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(date))
    if (part.type !== "literal") values[part.type] = Number(part.value);
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour % 24,
    minute: values.minute,
    second: values.second,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** The calendar date of an instant in the given timezone. */
export function localDate(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return formatDateKey(parts.year, parts.month, parts.day);
}

function utcMidnight(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function addDays(dateKey: string, days: number): string {
  const moved = new Date(utcMidnight(dateKey) + days * 86_400_000);
  return formatDateKey(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

/** Monday is 0 and Sunday is 6. */
export function weekdayIndex(dateKey: string): number {
  return (new Date(utcMidnight(dateKey)).getUTCDay() + 6) % 7;
}

export function startOfWeek(dateKey: string): string {
  return addDays(dateKey, -weekdayIndex(dateKey));
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const weekdayName = (dateKey: string) => WEEKDAYS[weekdayIndex(dateKey)];

/** "24 Nov" */
export function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** "Mon 24 Nov" */
export function shortWeekdayDate(dateKey: string): string {
  return `${weekdayName(dateKey).slice(0, 3)} ${shortDate(dateKey)}`;
}

function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads `dateKey` `hour`:`minute`. */
export function zonedTimeToInstant(dateKey: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetAt(guess, timeZone);
  let instant = guess - first;
  const second = offsetAt(instant, timeZone);
  if (second !== first) instant = guess - second;
  return new Date(instant);
}
