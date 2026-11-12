import { targetForColumn, type DropTarget } from "./board-moves.ts";
import type { BoardEntry, EarlierGroup, TimeColumn, WeekBoard } from "./week-board.ts";

export type TimelineSectionKind = "bucket" | "to-confirm" | "no-date" | "waiting" | "faded";

/** One stretch of the timeline: a gray divider and the cards under it. */
export type TimelineSection = {
  id: string;
  kind: TimelineSectionKind;
  /** "Today · thu 12", "fri 13", "next week", "december", "no date". */
  label: string;
  column: TimeColumn | null;
  /** Items due before today, under a soft "from Tue" sub-divider. Only on Today. */
  earlier: EarlierGroup[];
  entries: BoardEntry[];
  /** Where a card dropped on this stretch goes, if anywhere. */
  drop: DropTarget | null;
};

/**
 * The whole Home list in time order: Today, the adaptive buckets after it, then the
 * undated parts. Empty buckets stay out of the way unless a card is being dragged,
 * when they open up as places to drop it.
 */
export function timelineSections(board: WeekBoard, dragging: boolean): TimelineSection[] {
  const buckets = board.columns
    .filter((column) => column.isToday || column.entries.length > 0 || column.earlier.length > 0 || dragging)
    .map((column): TimelineSection => ({
      id: column.id,
      kind: "bucket",
      label: column.isToday ? `Today · ${column.label}` : column.label,
      column,
      earlier: column.earlier,
      entries: column.entries,
      drop: targetForColumn(column),
    }));
  const tail = (id: string, kind: TimelineSectionKind, label: string, entries: BoardEntry[], drop: DropTarget | null) =>
    ({ id, kind, label, column: null, earlier: [], entries, drop }) satisfies TimelineSection;
  return [
    ...buckets,
    ...[
      tail("to-confirm", "to-confirm", "to confirm", board.toConfirm, null),
      tail("no-date", "no-date", "no date", board.looseEnds, { type: "loose" }),
      tail("waiting", "waiting", "waiting on others", board.waiting, null),
      tail("faded", "faded", "faded", board.faded, null),
    ].filter((section) => section.entries.length > 0 || (dragging && section.kind === "no-date")),
  ];
}
