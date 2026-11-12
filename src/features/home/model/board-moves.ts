import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import type { HomeMutation } from "./action-mutations.ts";
import { addDays, daysBetween } from "./home-time.ts";
import { dayAnnouncement, dueRange, VISIBLE_DAYS } from "./week-board.ts";

/** Somewhere a card can be dropped. */
export type DropTarget =
  | { type: "day"; date: string }
  | { type: "later" }
  | { type: "loose" }
  | { type: "let-go" };

/** The change a drop or a key press asks for. */
export type BoardMove = { mutation: HomeMutation };

/** The due value after the card lands on `date`: the time of day is kept, a window is replaced. */
function dueOn(action: ActionItem, date: string): ActionPatch {
  const time = action.due && "date" in action.due ? action.due.time : undefined;
  return { due: time ? { date, time } : { date } };
}

function editMove(patch: ActionPatch, label: string): BoardMove {
  return { mutation: { type: "edit", patch, label } };
}

/**
 * Drop target to change. Returns null when nothing would change, so a card
 * dropped where it already is stays still and leaves no toast behind.
 */
export function moveForDrop(action: ActionItem, target: DropTarget, today: string): BoardMove | null {
  if (target.type === "let-go") return { mutation: { type: "not-important" } };
  if (target.type === "loose") {
    return action.due ? editMove({ due: null }, "Moved to loose ends.") : null;
  }
  const date = target.type === "later" ? addDays(today, VISIBLE_DAYS) : target.date;
  if (action.due && "date" in action.due && action.due.date === date) return null;
  return editMove(dueOn(action, date), `Moved to ${dayAnnouncement(date, today)}.`);
}

/** The day a card sits on, or null when it has none. Windows count from their start. */
export function currentDate(action: ActionItem): string | null {
  return dueRange(action.due)?.start ?? null;
}

/**
 * Shift+Left and Shift+Right move a card one day; Shift+Down sends it to the
 * loose ends. Nothing moves before today, and cards without a day start at today.
 */
export function moveForKey(action: ActionItem, key: "earlier" | "later" | "loose", today: string): BoardMove | null {
  if (key === "loose") return moveForDrop(action, { type: "loose" }, today);
  const current = currentDate(action);
  if (key === "later") {
    const next = current && daysBetween(today, current) >= 0 ? addDays(current, 1) : today;
    return moveForDrop(action, { type: "day", date: next }, today);
  }
  if (!current || daysBetween(today, current) <= 0) return null;
  return moveForDrop(action, { type: "day", date: addDays(current, -1) }, today);
}
