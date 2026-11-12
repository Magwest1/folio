import { boardGroups, type WeekBoard } from "./week-board.ts";

export type FocusDirection = "next" | "previous" | "left" | "right";

/**
 * The card to focus after an arrow or j/k press. Up/down (and k/j) walk every
 * card in reading order; left/right jump to the same row in the neighbouring column.
 */
export function neighbourId(board: WeekBoard, currentId: string | null, direction: FocusDirection): string | null {
  const groups = boardGroups(board);
  const flat = groups.flatMap((group) => group.entries.map((entry) => entry.action.id));
  if (!flat.length) return null;
  const at = currentId ? flat.indexOf(currentId) : -1;
  if (at === -1) return flat[0];
  if (direction === "next") return flat[Math.min(flat.length - 1, at + 1)];
  if (direction === "previous") return flat[Math.max(0, at - 1)];
  const column = groups.findIndex((group) => group.entries.some((entry) => entry.action.id === currentId));
  const row = groups[column].entries.findIndex((entry) => entry.action.id === currentId);
  const target = groups[column + (direction === "right" ? 1 : -1)];
  if (!target) return currentId;
  return target.entries[Math.min(row, target.entries.length - 1)].action.id;
}

/** Where focus should land when a card leaves the board: the next card, else the previous one. */
export function successorId(board: WeekBoard, id: string): string | null {
  const next = neighbourId(board, id, "next");
  if (next && next !== id) return next;
  const previous = neighbourId(board, id, "previous");
  return previous && previous !== id ? previous : null;
}
