import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import { fetchActions, patchAction, transitionAction } from "../../../lib/api.ts";
import {
  applyOptimistic,
  toastLabel,
  TRANSITION_FOR,
  type HomeMutation,
} from "../model/action-mutations.ts";
import { groupHomeActions, type HomeSections } from "../model/home-sections.ts";
import { deviceTimeZone } from "../model/home-time.ts";

export type HomeToast = {
  key: number;
  message: string;
  /** Present while the change can still be taken back. */
  undo?: () => void;
};

type Options = {
  /** Poll and refresh only while Home is actually on screen. */
  visible?: boolean;
  /** Reload when the bundle changes. */
  bundleId?: string;
  timeZone?: string;
  pollMs?: number;
  now?: () => Date;
};

const TOAST_MS = 8_000;
const FOCUS_REFRESH_GAP_MS = 4_000;

function replaceAction(list: ActionItem[], next: ActionItem): ActionItem[] {
  return list.some((item) => item.id === next.id)
    ? list.map((item) => (item.id === next.id ? next : item))
    : [...list, next];
}

function previousFields(action: ActionItem, patch: ActionPatch): ActionPatch {
  const previous: ActionPatch = {};
  for (const key of Object.keys(patch) as (keyof ActionPatch)[]) Object.assign(previous, { [key]: action[key] });
  return previous;
}

/**
 * Loads actions from the store and keeps them fresh. Every change is applied to
 * the screen first and reconciled with the server afterwards; nothing waits on a model.
 */
export function useHomeActions({
  visible = true,
  bundleId,
  timeZone = deviceTimeZone(),
  pollMs = 45_000,
  now = () => new Date(),
}: Options = {}) {
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [clock, setClock] = useState(() => now());
  const [toasts, setToasts] = useState<HomeToast[]>([]);
  const actionsRef = useRef(actions);
  const epochRef = useRef(0);
  const pendingRef = useRef(0);
  const lastRefreshRef = useRef(0);
  const toastKeyRef = useRef(0);
  const chainsRef = useRef(new Map<string, Promise<unknown>>());
  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  });

  const commit = useCallback((update: (current: ActionItem[]) => ActionItem[]) => {
    actionsRef.current = update(actionsRef.current);
    setActions(actionsRef.current);
  }, []);

  const refresh = useCallback(async () => {
    const epoch = epochRef.current;
    lastRefreshRef.current = Date.now();
    try {
      const [active, faded] = await Promise.all([fetchActions(), fetchActions({ status: ["faded"] })]);
      // A change made while this request was in flight is newer than the response.
      if (epoch !== epochRef.current || pendingRef.current > 0) return;
      commit(() => [...active, ...faded]);
      setClock(nowRef.current());
      setLoaded(true);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [commit]);

  /** Focus-driven refreshes are throttled so moving between cards stays cheap. */
  const refreshSoon = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    if (Date.now() - lastRefreshRef.current < FOCUS_REFRESH_GAP_MS) return;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setClock(nowRef.current());
      void refresh();
    }, pollMs);
    window.addEventListener("focus", refreshSoon);
    document.addEventListener("visibilitychange", refreshSoon);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshSoon);
      document.removeEventListener("visibilitychange", refreshSoon);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, pollMs, refresh, refreshSoon, visible]);

  const dismissToast = useCallback((key: number) => {
    setToasts((current) => current.filter((toast) => toast.key !== key));
  }, []);

  const showToast = useCallback((message: string, undo?: () => void) => {
    const key = ++toastKeyRef.current;
    setToasts((current) => [...current.slice(-2), { key, message, undo }]);
    window.setTimeout(() => dismissToast(key), TOAST_MS);
    return key;
  }, [dismissToast]);

  /** Requests for one action run in order, so an undo can never overtake the change it undoes. */
  const enqueue = useCallback(<T,>(id: string, task: () => Promise<T>): Promise<T> => {
    const run = (chainsRef.current.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    chainsRef.current.set(id, run);
    void run.then(
      () => chainsRef.current.get(id) === run && chainsRef.current.delete(id),
      () => chainsRef.current.get(id) === run && chainsRef.current.delete(id),
    );
    return run;
  }, []);

  const settle = useCallback(() => {
    pendingRef.current -= 1;
    if (pendingRef.current === 0) void refresh();
  }, [refresh]);

  const run = useCallback(async (id: string, mutation: HomeMutation) => {
    const before = actionsRef.current.find((item) => item.id === id);
    if (!before) return;
    epochRef.current += 1;
    pendingRef.current += 1;
    commit((current) => replaceAction(current, applyOptimistic(before, mutation, nowRef.current())));
    const takeBack = () => {
      epochRef.current += 1;
      pendingRef.current += 1;
      commit((current) => replaceAction(current, before));
      const request = mutation.type === "edit"
        ? patchAction(id, previousFields(before, mutation.patch))
        : transitionAction(id, "undo");
      void enqueue(id, () => request)
        .then((restored) => commit((current) => replaceAction(current, restored)))
        .catch(() => undefined)
        .finally(settle);
    };
    showToast(toastLabel(mutation), takeBack);
    try {
      const updated = await enqueue(id, () =>
        mutation.type === "edit"
          ? patchAction(id, mutation.patch)
          : transitionAction(id, TRANSITION_FOR[mutation.type], mutation.type === "snooze" ? { until: mutation.until } : {}),
      );
      commit((current) => replaceAction(current, updated));
    } catch {
      commit((current) => replaceAction(current, before));
      showToast("That didn't go through. It's back where it was.");
    } finally {
      settle();
    }
  }, [commit, enqueue, settle, showToast]);

  const sections: HomeSections = useMemo(
    () => groupHomeActions(actions, clock, timeZone),
    [actions, clock, timeZone],
  );

  return { actions, sections, loaded, unavailable, toasts, run, refresh, refreshSoon, dismissToast, timeZone, clock };
}
