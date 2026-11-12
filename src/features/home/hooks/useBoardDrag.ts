import { useCallback, useRef, useState, type DragEvent } from "react";
import type { ActionItem } from "../../../domain/types.ts";
import { moveForDrop, type BoardMove, type DropTarget } from "../model/board-moves.ts";

type Options = {
  today: string;
  findAction: (id: string) => ActionItem | undefined;
  onMove: (action: ActionItem, move: BoardMove) => void;
};

export type BoardDrag = {
  /** The card in the air, once the browser has started the drag. */
  draggingId: string | null;
  /** The drop target the card is over right now. */
  overKey: string | null;
  start: (event: DragEvent<HTMLElement>, action: ActionItem) => void;
  end: () => void;
  /** Spread onto anything that accepts a card. */
  target: (key: string, target: DropTarget) => {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
};

/**
 * Native drag and drop for cards. The card in the air is tracked here rather
 * than read from the event, so foreign drags (files, text) are never intercepted.
 */
export function useBoardDrag({ today, findAction, onMove }: Options): BoardDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const liftedRef = useRef<string | null>(null);

  const end = useCallback(() => {
    liftedRef.current = null;
    setDraggingId(null);
    setOverKey(null);
  }, []);

  const start = useCallback((event: DragEvent<HTMLElement>, action: ActionItem) => {
    liftedRef.current = action.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", action.text);
    const card = event.currentTarget;
    event.dataTransfer.setDragImage?.(card, 16, 16);
    // The source dims one tick later, so the drag ghost is taken from the card as it was.
    window.setTimeout(() => {
      if (liftedRef.current === action.id) setDraggingId(action.id);
    }, 0);
  }, []);

  const target = useCallback(
    (key: string, dropTarget: DropTarget) => ({
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!liftedRef.current) return;
        event.preventDefault();
        setOverKey(key);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!liftedRef.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOverKey(key);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        const into = event.relatedTarget;
        if (into instanceof Node && event.currentTarget.contains(into)) return;
        setOverKey((current) => (current === key ? null : current));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const id = liftedRef.current;
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        const action = findAction(id);
        const move = action ? moveForDrop(action, dropTarget, today) : null;
        end();
        if (action && move) onMove(action, move);
      },
    }),
    [end, findAction, onMove, today],
  );

  return { draggingId, overKey, start, end, target };
}
