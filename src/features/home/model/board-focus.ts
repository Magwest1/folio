import { boardGroups, type WeekBoard } from "./week-board.ts";

export type FocusDirection = "next" | "previous";

/** The card to focus after an arrow or j/k press: every card in timeline order. */
export function neighbourId(board: WeekBoard, currentId: string | null, direction: FocusDirection): string | null {
  const flat = boardGroups(board).flatMap((group) => group.entries.map((entry) => entry.action.id));
  if (!flat.length) return null;
  const at = currentId ? flat.indexOf(currentId) : -1;
  if (at === -1) return flat[0];
  return direction === "next" ? flat[Math.min(flat.length - 1, at + 1)] : flat[Math.max(0, at - 1)];
}

/** Where focus should land when a card leaves the board: the next card, else the previous one. */
export function successorId(board: WeekBoard, id: string): string | null {
  const next = neighbourId(board, id, "next");
  if (next && next !== id) return next;
  const previous = neighbourId(board, id, "previous");
  return previous && previous !== id ? previous : null;
}
