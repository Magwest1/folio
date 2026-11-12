import { useId, type KeyboardEvent } from "react";
import type { BoardLayout } from "../hooks/useBoardLayout.ts";
import { neighbourId } from "../model/board-focus.ts";
import { moveForKey } from "../model/board-moves.ts";
import { isTypingTarget } from "../model/focus-rules.ts";
import { BOARD_HINT, boardCommand } from "../model/triage-keys.ts";
import type { BoardEntry, WeekBoard } from "../model/week-board.ts";
import { boardGroups } from "../model/week-board.ts";
import type { BoardEnv } from "./BoardCard.tsx";
import { HomeTray } from "./HomeTray.tsx";
import { WeekGrid } from "./WeekGrid.tsx";

type HomeBoardProps = {
  board: WeekBoard;
  env: BoardEnv;
  layout: BoardLayout;
  /** Put the keyboard on a card right now. */
  moveFocus: (id: string) => void;
};

function findEntry(board: WeekBoard, id: string): BoardEntry | undefined {
  return boardGroups(board)
    .flatMap((group) => group.entries)
    .concat(board.faded)
    .find((entry) => entry.action.id === id);
}

/**
 * The storyboard and its tray. Keys apply only while focus is on a card inside
 * the region, and never while typing, so the writing field stays untouched.
 */
export function HomeBoard({ board, env, layout, moveFocus }: HomeBoardProps) {
  const hintId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || isTypingTarget(event.target)) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-board-card]");
    const id = element?.dataset.actionId;
    const command = boardCommand(event);
    if (!command) return;
    if (!element && command.type === "focus" && event.target === event.currentTarget) {
      // Focus rests on the board itself after a card leaves; arrows pick the thread back up.
      const first = neighbourId(board, null, command.direction);
      if (first) {
        event.preventDefault();
        moveFocus(first);
      }
      return;
    }
    if (!element || !id) return;
    const entry = findEntry(board, id);
    if (!entry) return;
    const { action } = entry;
    const live = !entry.completed && entry.placement !== "faded";
    const onCard = event.target === element;

    if (command.type === "focus") {
      event.preventDefault();
      const next = neighbourId(board, id, command.direction);
      if (next) moveFocus(next);
      return;
    }
    if (command.type === "open-source") {
      // Enter on a button inside the card belongs to the button.
      if (!onCard || !action.anchor?.noteId) return;
      event.preventDefault();
      env.onOpenSource(action);
      return;
    }
    const act = (run: () => void) => {
      event.preventDefault();
      run();
    };
    if (command.type === "move") {
      const move = live ? moveForKey(action, command.to, board.today) : null;
      if (move) act(() => env.onMutate(action, move.mutation));
      return;
    }
    if (command.type === "not-important") return act(() => env.onMutate(action, { type: "not-important" }));
    if (entry.placement === "faded") {
      if (command.type === "accept") act(() => env.onMutate(action, { type: "reopen" }));
      return;
    }
    if (entry.completed) return;
    if (command.type === "accept" && entry.suggested) act(() => env.onMutate(action, { type: "accept" }));
    else if (command.type === "not-an-action" && entry.suggested)
      act(() => env.onMutate(action, { type: "not-an-action" }));
    else if (command.type === "done" && !entry.suggested) act(() => env.onMutate(action, { type: "done" }));
    else if (command.type === "edit") act(() => env.setEditingId(id));
    else if (command.type === "snooze") act(() => env.setSnoozeId(id));
  }

  return (
    <div
      className="home-board"
      data-home-board=""
      data-layout={layout}
      tabIndex={-1}
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
    >
      <WeekGrid board={board} env={env} layout={layout} />
      <HomeTray board={board} env={env} />
      <p id={hintId} className="board-hint">
        {BOARD_HINT}
      </p>
    </div>
  );
}
