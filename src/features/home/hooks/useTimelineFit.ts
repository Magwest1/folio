import { useLayoutEffect, useState, type RefObject } from "react";

export type TimelineFit = "timeline" | "page";

/** Below this pane height the timeline gives up its own scroller and the whole page scrolls. */
export const PAGE_SCROLL_BELOW_PX = 560;

/**
 * Follows the height of the Home pane itself. The timeline fills what is left under the
 * writing field; in a pane too short for that, the page scrolls instead so nothing is cut off.
 */
export function useTimelineFit(ref: RefObject<HTMLElement | null>): TimelineFit {
  const [fit, setFit] = useState<TimelineFit>("timeline");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (height: number) => {
      // An unmeasured pane (no layout yet) keeps the timeline.
      if (height > 0) setFit(height < PAGE_SCROLL_BELOW_PX ? "page" : "timeline");
    };
    apply(element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.height ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return fit;
}
