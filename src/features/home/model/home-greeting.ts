import type { WeekBoard } from "./week-board.ts";
import { weekdayName, zonedParts } from "./home-time.ts";

export type HomeGreeting = {
  /** "Good morning. Thursday looks fairly light." */
  headline: string;
  /** "3 things today · 2 waiting on others" */
  summary: string;
};

export function partOfDay(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

const OPENING = {
  morning: "Good morning.",
  afternoon: "Good afternoon.",
  evening: "Good evening.",
  night: "Hello.",
} as const;

/** A small set of calm phrasings. Never alarming, never a score. */
function loadPhrase(weekday: string, today: number): string {
  if (today === 0) return `${weekday} is wide open.`;
  if (today <= 2) return `${weekday} looks fairly light.`;
  if (today <= 5) return `${weekday} looks steady.`;
  return `${weekday} looks full. One thing at a time.`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Deterministic wording from the time of day and the counts. No model involved. */
export function homeGreeting(board: WeekBoard, now: Date, timeZone: string): HomeGreeting {
  const { hour } = zonedParts(now, timeZone);
  const { today, comingUp, waiting, toConfirm } = board.summary;
  const headline = `${OPENING[partOfDay(hour)]} ${loadPhrase(weekdayName(board.today), today)}`;
  if (board.empty) return { headline, summary: "Nothing needs you right now." };
  const parts = [
    today > 0 ? plural(today, "thing today", "things today") : "Nothing today",
    ...(today === 0 && comingUp > 0 ? [`${comingUp} coming up`] : []),
    ...(waiting > 0 ? [`${waiting} waiting on others`] : []),
    ...(toConfirm > 0 ? [`${toConfirm} to confirm`] : []),
  ];
  return { headline, summary: parts.join(" · ") };
}
