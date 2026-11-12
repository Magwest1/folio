import { addDays, localDate, startOfWeek, zonedParts, zonedTimeToInstant } from "./home-time.ts";

export type SnoozePresetId = "later-today" | "tomorrow-morning" | "next-week";
export type SnoozePreset = { id: SnoozePresetId; label: string; until: string };

const MORNING_HOUR = 9;
const LATEST_HOUR = 21;
const LATER_TODAY_HOURS = 3;

/**
 * Plain presets computed on the user's wall clock. "Later today" is dropped
 * once the evening is too far gone to be meaningfully later.
 */
export function snoozePresets(now: Date, timeZone: string): SnoozePreset[] {
  const today = localDate(now, timeZone);
  const hour = zonedParts(now, timeZone).hour;
  const presets: SnoozePreset[] = [];
  const laterHour = Math.min(LATEST_HOUR, hour + LATER_TODAY_HOURS);
  if (laterHour > hour)
    presets.push({
      id: "later-today",
      label: "Later today",
      until: zonedTimeToInstant(today, laterHour, 0, timeZone).toISOString(),
    });
  presets.push({
    id: "tomorrow-morning",
    label: "Tomorrow morning",
    until: zonedTimeToInstant(addDays(today, 1), MORNING_HOUR, 0, timeZone).toISOString(),
  });
  presets.push({
    id: "next-week",
    label: "Next week",
    until: zonedTimeToInstant(addDays(startOfWeek(today), 7), MORNING_HOUR, 0, timeZone).toISOString(),
  });
  return presets;
}

/** "Fri 13, 09:00": where a snooze ends, in the words the undo toast uses. */
export function snoozeLabel(until: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(until));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")}, ${part("hour")}:${part("minute")}`;
}
