import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import {
  clearNoteActions,
  fetchActions,
  patchAction,
  snoozeActionWithPhrase,
  transitionAction,
  undoActionBatch,
} from "../../../lib/api.ts";
import {
  applyOptimistic,
  toastLabel,
  TRANSITION_FOR,
  type HomeMutation,
} from "../model/action-mutations.ts";
import { MAX_BUDGET } from "../model/time-buckets.ts";
import { deviceTimeZone } from "../model/home-time.ts";
import { snoozeLabel } from "../model/snooze-presets.ts";
import { buildWeekBoard, type WeekBoard } from "../model/week-board.ts";

export type HomeToastAction = { label: string; run: () => void };

export type HomeToast = {
  key: number;
  message: string;
  /** Present while the change can still be taken back. */
  undo?: () => void;
  /** A reminder is a quiet toast with its own choices instead of an undo. */
  reminder?: { detail: string; actions: HomeToastAction[] };
};

type Options = {
  /** Poll and refresh only while Home is actually on screen. */
  visible?: boolean;
  /** Reload when the bundle changes. */
  bundleId?: string;
  timeZone?: string;
  pollMs?: number;
  /** Columns the board can hold, Today and Later included. */
  columns?: number;
  now?: () => Date;
};

const TOAST_MS = 8_000;
const REMINDER_TOAST_MS = 25_000;
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
  columns = MAX_BUDGET,
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
      // Done items come along so the ones finished today can stay on the board until tomorrow.
      const [active, quiet] = await Promise.all([fetchActions(), fetchActions({ status: ["faded", "done"] })]);
      // A change made while this request was in flight is newer than the response.
      if (epoch !== epochRef.current || pendingRef.current > 0) return;
      commit(() => [...active, ...quiet]);
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

  const showToast = useCallback((message: string, undo?: () => void, reminder?: HomeToast["reminder"]) => {
    const key = ++toastKeyRef.current;
    setToasts((current) => [...current.slice(-2), { key, message, undo, reminder }]);
    window.setTimeout(() => dismissToast(key), reminder ? REMINDER_TOAST_MS : TOAST_MS);
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
    // Keeping an item or dismissing a suggestion changes nothing visible, and taking back an undo is not offered.
    const quiet = mutation.type === "keep" || mutation.type === "dismiss-completion" || mutation.type === "undo-auto";
    showToast(toastLabel(mutation), quiet ? undefined : takeBack);
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

  /**
   * Snoozes with words ("tomorrow after lunch"). The server reads the phrase, so nothing is shown until it
   * answers; the result is the error to display next to the field, or null once it went through.
   */
  const snoozeWithPhrase = useCallback(async (id: string, phrase: string): Promise<string | null> => {
    const before = actionsRef.current.find((item) => item.id === id);
    if (!before) return "That card is no longer here.";
    epochRef.current += 1;
    pendingRef.current += 1;
    try {
      const updated = await enqueue(id, () => snoozeActionWithPhrase(id, phrase, timeZone));
      commit((current) => replaceAction(current, updated));
      showToast(`Snoozed until ${snoozeLabel(updated.until, timeZone)}.`, () => {
        epochRef.current += 1;
        pendingRef.current += 1;
        commit((current) => replaceAction(current, before));
        void enqueue(id, () => transitionAction(id, "undo"))
          .then((restored) => commit((current) => replaceAction(current, restored)))
          .catch(() => undefined)
          .finally(settle);
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "That didn't go through.";
    } finally {
      settle();
    }
  }, [commit, enqueue, settle, showToast, timeZone]);

  /** Lets go of everything from one note, as a single step that can be taken back. */
  const clearNote = useCallback(async (noteId: string, title: string | null) => {
    epochRef.current += 1;
    pendingRef.current += 1;
    try {
      const { ids } = await clearNoteActions(noteId);
      const gone = new Set(ids);
      commit((current) => current.filter((item) => !gone.has(item.id)));
      if (ids.length === 0) {
        showToast("Nothing open from this note.");
        return;
      }
      const noun = ids.length === 1 ? "1 item" : `${ids.length} items`;
      showToast(`Let go of ${noun} from ${title ?? "this note"}. They won't come back.`, () => {
        epochRef.current += 1;
        pendingRef.current += 1;
        void undoActionBatch(ids)
          .catch(() => undefined)
          .finally(settle);
      });
    } catch {
      showToast("That didn't go through. Nothing was changed.");
    } finally {
      settle();
    }
  }, [commit, settle, showToast]);

  const board: WeekBoard = useMemo(
    () => buildWeekBoard(actions, clock, timeZone, columns),
    [actions, clock, columns, timeZone],
  );

  return {
    actions, board, loaded, unavailable, toasts, run, refresh, refreshSoon, dismissToast, showToast,
    snoozeWithPhrase, clearNote, timeZone, clock,
  };
}
