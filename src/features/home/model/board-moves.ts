import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import type { HomeMutation } from "./action-mutations.ts";
import { dayAnnouncement } from "./time-buckets.ts";
import { dueRange, type BoardEntry, type TimeColumn, type WeekBoard } from "./week-board.ts";

/** Somewhere a card can be dropped. */
export type DropTarget =
  | { type: "day"; date: string }
  /** A range, week or month: the card gets a window covering it. */
  | { type: "span"; start: string; end: string; label: string }
  /** The first day after the last column. */
  | { type: "later"; date: string }
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

/** What dropping on a column means: a day for single days, a window for anything wider. */
export function targetForColumn(column: TimeColumn): DropTarget {
  if (column.kind === "today" || column.kind === "day") return { type: "day", date: column.start };
  if (column.kind === "later" || !column.end) return { type: "later", date: column.start };
  return { type: "span", start: column.start, end: column.end, label: column.fullLabel };
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
  if (target.type === "span") {
    const due = action.due;
    if (due && "window" in due && due.window.start === target.start && due.window.end === target.end) return null;
    return editMove({ due: { window: { start: target.start, end: target.end } } }, `Moved to ${target.label}.`);
  }
  if (action.due && "date" in action.due && action.due.date === target.date) return null;
  return editMove(dueOn(action, target.date), `Moved to ${dayAnnouncement(target.date, today)}.`);
}

/** The day a card sits on, or null when it has none. Windows count from their start. */
export function currentDate(action: ActionItem): string | null {
  return dueRange(action.due)?.start ?? null;
}

/**
 * Shift+Left and Shift+Right move a card to the neighbouring column, by the same rules as
 * a drop; Shift+Down sends it to the loose ends. Nothing moves before Today, and cards
 * without a column, or from an earlier day, start at Today.
 */
export function moveForKey(
  entry: BoardEntry,
  key: "earlier" | "later" | "loose",
  board: WeekBoard,
): BoardMove | null {
  const { action } = entry;
  const today = board.today;
  if (key === "loose") return moveForDrop(action, { type: "loose" }, today);
  const index = board.columns.findIndex((column) => column.id === entry.column);
  const fresh = index === -1 || entry.placement === "earlier";
  if (key === "later") {
    if (fresh) return moveForDrop(action, { type: "day", date: today }, today);
    const next = board.columns[index + 1];
    return next ? moveForDrop(action, targetForColumn(next), today) : null;
  }
  const previous = fresh ? undefined : board.columns[index - 1];
  return previous ? moveForDrop(action, targetForColumn(previous), today) : null;
}
