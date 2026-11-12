import {
  addDays,
  daysBetween,
  formatDateKey,
  shortDate,
  startOfWeek,
  weekdayIndex,
  weekdayName,
} from "./home-time.ts";

/** Open dated items the board tries to show before it stops zooming out. */
export const HORIZON_TARGET = 8;
/** How far the board may zoom out: about six months. Anything beyond goes in Later. */
export const HORIZON_CAP_DAYS = 183;
/** Today plus six single days is where every board starts. */
export const DAY_COLUMNS = 7;
/** Weeks stand alone for about four weeks; after that the ladder counts in months. */
const WEEK_ZONE_DAYS = 27;
/** Fewest and most columns, Today and Later included. */
export const MIN_BUDGET = 4;
export const MAX_BUDGET = 8;

export type ColumnKind = "today" | "day" | "range" | "week" | "month" | "later";

/** One column of the storyboard, before any items are placed in it. */
export type ColumnSpec = {
  id: string;
  kind: ColumnKind;
  start: string;
  /** Null only for Later, which has no end. */
  end: string | null;
  /** "fri 13", "sat–sun", "next week", "december", "jan–mar". Lowercase and calm. */
  label: string;
  /** For announcements: "Friday 13", "next week", "December". */
  fullLabel: string;
  /** Every day in the column is a weekend day. */
  weekend: boolean;
  isToday: boolean;
};

export type TimeColumnsInput = {
  today: string;
  /** The date of every open dated item: earlier items and returning snoozes count as today. */
  dates: string[];
  /**
   * Window items count toward how far the board zooms out, but do not shape the columns,
   * so a window dropped on a column stays inside it.
   */
  windows?: string[];
  /** Columns the pane can hold, Today and Later included. */
  budget: number;
  target?: number;
  capDays?: number;
};

/** How many columns fit in a pane of this width. Narrower panes use fewer, wider columns. */
export function columnBudget(width: number): number {
  if (width <= 0 || width < 640) return MAX_BUDGET;
  if (width >= 1200) return 8;
  if (width >= 1060) return 7;
  if (width >= 930) return 6;
  if (width >= 790) return 5;
  return MIN_BUDGET;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const monthOf = (date: string) => MONTH_NAMES[parts(date)[1] - 1];
const short = (date: string) => monthOf(date).slice(0, 3);
export const endOfMonth = (date: string) => {
  const [year, month] = parts(date);
  return addDays(month === 12 ? formatDateKey(year + 1, 1, 1) : formatDateKey(year, month + 1, 1), -1);
};
const endOfWeek = (date: string) => addDays(startOfWeek(date), 6);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "fri 13", and the month on the first of a month: "tue 1 dec". */
export function dayLabel(date: string): { label: string; fullLabel: string } {
  const day = parts(date)[2];
  const weekday = weekdayName(date);
  return {
    label: `${weekday.slice(0, 3).toLowerCase()} ${day}${day === 1 ? ` ${short(date)}` : ""}`,
    fullLabel: `${weekday} ${day}`,
  };
}

/** "Friday 13" for the days on the board's first week, "Friday 13 Dec" beyond it. */
export function dayAnnouncement(date: string, today: string): string {
  const offset = daysBetween(today, date);
  if (offset === 0) return "today";
  const base = `${weekdayName(date)} ${parts(date)[2]}`;
  return offset > 0 && offset < DAY_COLUMNS ? base : `${base} ${shortDate(date).split(" ")[1]}`;
}

function numericRange(start: string, end: string) {
  const [, startMonth, startDay] = parts(start);
  const [, endMonth, endDay] = parts(end);
  return startMonth === endMonth
    ? `${startDay}–${endDay} ${short(end)}`
    : `${startDay} ${short(start)}–${endDay} ${short(end)}`;
}

function describeSpan(start: string, end: string, today: string): Pick<ColumnSpec, "kind" | "label" | "fullLabel"> {
  if (start === end) return { kind: "day", ...dayLabel(start) };
  const todayYear = parts(today)[0];
  const year = (date: string) => (parts(date)[0] === todayYear ? "" : ` ${parts(date)[0]}`);
  if (weekdayIndex(start) === 0 && daysBetween(start, end) === 6) {
    const thisWeek = startOfWeek(today);
    const label = start === addDays(thisWeek, 7) ? "next week" : start === thisWeek ? "this week" : numericRange(start, end);
    return { kind: "week", label, fullLabel: label === numericRange(start, end) ? `the week of ${shortDate(start)}` : label };
  }
  if (parts(start)[2] === 1 && end === endOfMonth(start)) {
    const name = `${monthOf(start)}${year(start)}`;
    return { kind: "month", label: name, fullLabel: capital(name) };
  }
  if (parts(start)[2] === 1 && end === endOfMonth(end)) {
    return {
      kind: "range",
      label: `${short(start)}${year(start)}–${short(end)}${year(end)}`,
      fullLabel: `${capital(monthOf(start))}${year(start)} to ${capital(monthOf(end))}${year(end)}`,
    };
  }
  if (startOfWeek(start) === startOfWeek(end)) {
    return {
      kind: "range",
      label: `${weekdayName(start).slice(0, 3).toLowerCase()}–${weekdayName(end).slice(0, 3).toLowerCase()}`,
      fullLabel: `${weekdayName(start)} to ${weekdayName(end)}`,
    };
  }
  return { kind: "range", label: numericRange(start, end), fullLabel: `${shortDate(start)} to ${shortDate(end)}` };
}

/**
 * How a card dated inside a column names its date: nothing in a single-day column,
 * "fri 20" while the column is a few weeks wide, "3 dec" beyond that.
 */
export function entryDateLabel(date: string, column: Pick<ColumnSpec, "kind" | "start" | "end">): string | null {
  if (column.kind === "day" || column.kind === "today") return null;
  if (column.kind === "later" || column.kind === "month" || !column.end || daysBetween(column.start, column.end) > 31)
    return `${parts(date)[2]} ${short(date)}`;
  return `${weekdayName(date).slice(0, 3).toLowerCase()} ${parts(date)[2]}`;
}

/** A bucket on the ladder. Level 0 is days, 1 is weeks, 2 is months. */
type Bucket = { start: string; end: string; level: 0 | 1 | 2; count: number };

/** The calendar-aligned ladder after Today: single days, the rest of that week, whole weeks, whole months. */
function ladder(today: string, capDays: number): Omit<Bucket, "count">[] {
  const rungs: Omit<Bucket, "count">[] = [];
  for (let offset = 1; offset < DAY_COLUMNS; offset += 1) {
    const date = addDays(today, offset);
    rungs.push({ start: date, end: date, level: 0 });
  }
  const lastDay = addDays(today, DAY_COLUMNS - 1);
  let cursor = addDays(lastDay, 1);
  if (endOfWeek(lastDay) > lastDay) {
    rungs.push({ start: cursor, end: endOfWeek(lastDay), level: 0 });
    cursor = addDays(endOfWeek(lastDay), 1);
  }
  const weeksEnd = endOfWeek(addDays(today, WEEK_ZONE_DAYS));
  for (; cursor <= weeksEnd; cursor = addDays(cursor, 7)) rungs.push({ start: cursor, end: addDays(cursor, 6), level: 1 });
  const capDate = addDays(today, capDays);
  for (; cursor <= capDate; cursor = addDays(endOfMonth(cursor), 1))
    rungs.push({ start: cursor, end: endOfMonth(cursor), level: 2 });
  return rungs;
}

function merge(left: Bucket, right: Bucket): Bucket {
  return { start: left.start, end: right.end, level: left.level, count: left.count + right.count };
}

const isWholeWeek = (start: string, end: string) => weekdayIndex(start) === 0 && daysBetween(start, end) === 6;
const isWholeMonths = (start: string, end: string) => parts(start)[2] === 1 && end === endOfMonth(end);

/**
 * What it costs to show buckets `from` to `to` as one column. Items in a wide column are
 * cheaper the further they are from Today, so far-out and sparse time merges first. A group
 * stays inside one rung of the ladder (day runs inside one Monday to Sunday week); crossing
 * rungs is allowed only when the budget leaves no other way.
 */
function groupCost(buckets: Bucket[], from: number, to: number, today: string): number {
  const group = buckets.slice(from, to + 1);
  const start = group[0].start;
  const end = group[group.length - 1].end;
  const items = group.reduce((total, bucket) => total + bucket.count, 0);
  const near = 1 + 3 / (1 + Math.max(0, daysBetween(today, start)) / 7);
  let cost = items * Math.sqrt(daysBetween(start, end) + 1) * near + 0.5;
  if (group.length === 1) return cost;
  const levels = new Set(group.map((bucket) => bucket.level));
  const sameRung = levels.size === 1 && (group[0].level !== 0 || startOfWeek(start) === startOfWeek(end));
  if (!sameRung) return cost + 100 * levels.size + (levels.size === 1 ? 100 : 0);
  if (isWholeWeek(start, end) || isWholeMonths(start, end)) cost -= 0.25;
  return cost;
}

/** The cheapest way to cut the buckets into at most `slots` consecutive columns. */
function partition(buckets: Bucket[], slots: number, today: string): Bucket[] {
  const size = buckets.length;
  const best = Array.from({ length: slots + 1 }, () => new Array<number>(size + 1).fill(Infinity));
  const cut = Array.from({ length: slots + 1 }, () => new Array<number>(size + 1).fill(0));
  best[0][0] = 0;
  for (let columns = 1; columns <= slots; columns += 1)
    for (let end = 1; end <= size; end += 1)
      for (let from = columns - 1; from < end; from += 1) {
        const cost = best[columns - 1][from] + groupCost(buckets, from, end - 1, today);
        if (cost < best[columns][end]) {
          best[columns][end] = cost;
          cut[columns][end] = from;
        }
      }
  let columns = 1;
  for (let count = 2; count <= slots; count += 1) if (best[count][size] < best[columns][size]) columns = count;
  const merged: Bucket[] = [];
  for (let end = size; end > 0; columns -= 1) {
    const from = cut[columns][end];
    merged.unshift(buckets.slice(from, end).reduce(merge));
    end = from;
  }
  return merged;
}

/**
 * The ordered columns of the board: Today, then single days that zoom out to day runs,
 * weeks, months and month ranges as far as needed, and an open-ended Later.
 *
 * The horizon grows rung by rung while fewer than `target` dated items are in view,
 * stopping at the last dated item or the cap. Buckets are then merged to fit `budget`,
 * sparse and far-out ones first, so the board is dense near Today and coarse to the right.
 * It depends only on the date and the items, so it never moves under the user's hands.
 */
export function buildTimeColumns({
  today,
  dates,
  windows = [],
  budget,
  target = HORIZON_TARGET,
  capDays = HORIZON_CAP_DAYS,
}: TimeColumnsInput): ColumnSpec[] {
  const rungs = ladder(today, capDays);
  const lastRung = rungs.at(-1)?.end ?? today;
  const everything = [...dates, ...windows];
  const upTo = (end: string) => everything.filter((date) => date <= end).length;
  let reach = DAY_COLUMNS - 2;
  while (
    reach + 1 < rungs.length &&
    upTo(rungs[reach].end) < target &&
    everything.some((date) => date > rungs[reach].end && date <= lastRung)
  )
    reach += 1;

  let buckets: Bucket[] = rungs.slice(0, reach + 1).map((rung) => ({
    ...rung,
    count: dates.filter((date) => date >= rung.start && date <= rung.end).length,
  }));

  buckets = partition(buckets, Math.max(1, budget - 2), today);

  const columns: ColumnSpec[] = [
    { id: `today:${today}`, kind: "today", start: today, end: today, ...dayLabel(today), weekend: false, isToday: true },
    ...buckets.map((bucket): ColumnSpec => {
      const description = describeSpan(bucket.start, bucket.end, today);
      let weekend = true;
      for (let date = bucket.start; date <= bucket.end && weekend; date = addDays(date, 1)) weekend = weekdayIndex(date) >= 5;
      return { id: `${description.kind}:${bucket.start}`, ...description, start: bucket.start, end: bucket.end, weekend, isToday: false };
    }),
  ];
  const horizon = columns.at(-1)?.end ?? today;
  columns.push({
    id: "later",
    kind: "later",
    start: addDays(horizon, 1),
    end: null,
    label: "later",
    fullLabel: "later",
    weekend: false,
    isToday: false,
  });
  return columns;
}
