import { useLayoutEffect, useState, type RefObject } from "react";

export type BoardLayout = "board" | "agenda";

/** Below this width the board is a vertical agenda: narrow panes and split groups. */
export const AGENDA_BELOW_PX = 640;

/** Follows the width of the Home pane itself, not the window, so split groups adapt too. */
export function useBoardLayout(ref: RefObject<HTMLElement | null>): BoardLayout {
  const [layout, setLayout] = useState<BoardLayout>("board");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (width: number) => {
      // An unmeasured pane (no layout yet) keeps the full board.
      if (width > 0) setLayout(width < AGENDA_BELOW_PX ? "agenda" : "board");
    };
    apply(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return layout;
}
