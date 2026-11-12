import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent, type RefObject } from "react";
import { canDragScrollFrom } from "../model/focus-rules.ts";

type Options = {
  scrollerRef: RefObject<HTMLElement | null>;
  /** The timeline owns the scrolling. In a short pane the page scrolls and the sticky label is off. */
  ownsScroll: boolean;
  /** Changes whenever the dividers change, so the observer is rebuilt. */
  dividersKey: string;
  /** A card is in the air: the timeline scrolls when it nears an edge. */
  dragging: boolean;
  /** Bumps when the user opens Home on purpose; the list lands on Today. */
  focusRequest: number;
};

/** The sticky label covers the top of the list; a divider counts as passed once it slides under it. */
const STICKY_PX = 34;
const EDGE_PX = 64;
const TOP_SPEED = 16;
const DRAG_START_PX = 5;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/** Scroll-driven card effects need the browser to support them and the user not to opt out. */
export function scrollEffectsAvailable(): boolean {
  return typeof CSS !== "undefined" && CSS.supports?.("animation-timeline: view()") === true && !reducedMotion();
}

/**
 * Everything that makes the Home timeline feel like the history timeline: the sticky day label,
 * drag to scroll, edge scrolling while a card is dragged, and landing on Today.
 */
export function useTimelineScroll({ scrollerRef, ownsScroll, dividersKey, dragging, focusRequest }: Options) {
  const [stickyLabel, setStickyLabel] = useState<string | null>(null);
  const [effects, setEffects] = useState(scrollEffectsAvailable);
  const grab = useRef<{ pointerId: number; y: number; top: number } | null>(null);
  const draggingRef = useRef(dragging);
  const pointerY = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    draggingRef.current = dragging;
  });

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = () => setEffects(scrollEffectsAvailable());
    query?.addEventListener?.("change", change);
    return () => query?.removeEventListener?.("change", change);
  }, []);

  // The label of the last divider that has scrolled off the top. Observed, never measured per frame.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !ownsScroll || typeof IntersectionObserver === "undefined") {
      setStickyLabel(null);
      return;
    }
    const dividers = [...root.querySelectorAll<HTMLElement>("[data-timeline-divider]")];
    const passed = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const top = entry.rootBounds?.top ?? 0;
          if (!entry.isIntersecting && entry.boundingClientRect.bottom <= top + 1) passed.add(entry.target);
          else passed.delete(entry.target);
        }
        const current = [...dividers].reverse().find((divider) => passed.has(divider));
        setStickyLabel(current?.dataset.label ?? null);
      },
      { root, rootMargin: `-${STICKY_PX}px 0px 0px 0px`, threshold: [0, 1] },
    );
    for (const divider of dividers) observer.observe(divider);
    return () => observer.disconnect();
  }, [scrollerRef, ownsScroll, dividersKey]);

  // Opening Home, or pressing the shortcut again, lands on Today at the top.
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node?.scrollTo) return;
    node.scrollTo({ top: 0, behavior: reducedMotion() ? "instant" : "smooth" });
  }, [focusRequest, scrollerRef]);

  // Edge scrolling while a card is dragged: one rAF loop, one rect read per frame, only mid-drag.
  useEffect(() => {
    if (!dragging) {
      pointerY.current = null;
      return;
    }
    const pump = () => {
      const node = scrollerRef.current;
      const y = pointerY.current;
      if (node && y !== null) {
        const rect = node.getBoundingClientRect();
        const fromTop = y - rect.top;
        const fromBottom = rect.bottom - y;
        if (fromTop < EDGE_PX) node.scrollTop -= Math.ceil((1 - Math.max(0, fromTop) / EDGE_PX) * TOP_SPEED);
        else if (fromBottom < EDGE_PX) node.scrollTop += Math.ceil((1 - Math.max(0, fromBottom) / EDGE_PX) * TOP_SPEED);
      }
      frame.current = window.requestAnimationFrame(pump);
    };
    frame.current = window.requestAnimationFrame(pump);
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [dragging, scrollerRef]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (draggingRef.current) pointerY.current = event.clientY;
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !canDragScrollFrom(event.target)) return;
    grab.current = { pointerId: event.pointerId, y: event.clientY, top: event.currentTarget.scrollTop };
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    const distance = event.clientY - held.y;
    if (Math.abs(distance) <= DRAG_START_PX) return;
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.scrollTop = held.top - distance;
  }, []);

  const onPointerEnd = useCallback(() => {
    grab.current = null;
  }, []);

  return { stickyLabel, effects, handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onDragOver } };
}
