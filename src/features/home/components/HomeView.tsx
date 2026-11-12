import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActionItem, ReminderItem } from "../../../domain/types.ts";
import { useBoardDrag } from "../hooks/useBoardDrag.ts";
import { useBoardLayout } from "../hooks/useBoardLayout.ts";
import { useHomeActions } from "../hooks/useHomeActions.ts";
import { useHomeCapture } from "../hooks/useHomeCapture.ts";
import { useReminderFeed } from "../hooks/useReminderFeed.ts";
import type { HomeMutation } from "../model/action-mutations.ts";
import { successorId } from "../model/board-focus.ts";
import { homeGreeting } from "../model/home-greeting.ts";
import { reminderToast } from "../model/reminder-toast.ts";
import { snoozePresets } from "../model/snooze-presets.ts";
import { boardGroups, type WeekBoard } from "../model/week-board.ts";
import type { BoardEnv } from "./BoardCard.tsx";
import { HomeBoard } from "./HomeBoard.tsx";
import { HomeCapture } from "./HomeCapture.tsx";
import { HomeHeader } from "./HomeHeader.tsx";
import { HomeToasts } from "./HomeToasts.tsx";
import { LetGoZone } from "./LetGoZone.tsx";

export type HomeViewProps = {
  bundleId: string;
  groupId: string;
  /** This group is the one the user is working in. */
  active: boolean;
  focusRequest: number;
  /** A notification asked for this card. `seq` makes asking twice for the same card count. */
  focusAction?: { id: string | null; seq: number } | null;
  titleForNote: (noteId: string | null | undefined) => string | null;
  onFileCapture: (groupId: string, text: string) => void;
  onOpenAsDraft: (groupId: string, text: string) => void;
  onOpenSource: (action: ActionItem) => void;
  /** Test seams. */
  pollMs?: number;
  now?: () => Date;
  timeZone?: string;
};

type PendingFocus = { id: string; fallback: string | null };

function cardElement(root: HTMLElement | null, id: string | null): HTMLElement | null {
  if (!root || !id) return null;
  return [...root.querySelectorAll<HTMLElement>("[data-board-card]")].find((card) => card.dataset.actionId === id) ?? null;
}

/** Where the app starts: write first, then see the week. */
export function HomeView({
  bundleId,
  groupId,
  active,
  focusRequest,
  focusAction = null,
  titleForNote,
  onFileCapture,
  onOpenAsDraft,
  onOpenSource,
  pollMs,
  now,
  timeZone,
}: HomeViewProps) {
  const capture = useHomeCapture(bundleId);
  const rootRef = useRef<HTMLDivElement>(null);
  const { layout, budget } = useBoardLayout(rootRef);
  const {
    actions, board: liveBoard, loaded, unavailable, toasts, run, refresh, refreshSoon, dismissToast, showToast,
    snoozeWithPhrase, clearNote, clock, timeZone: zone,
  } = useHomeActions({ bundleId, pollMs, now, timeZone, columns: budget });
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const [frozen, setFrozen] = useState<WeekBoard | null>(null);

  /**
   * After a card leaves the screen or a form closes, keep the keyboard where the
   * user was working. It only applies if focus was lost, never over something the user chose.
   */
  const keepFocus = useCallback((id: string, fallback: string | null) => {
    pendingFocusRef.current = { id, fallback };
    window.requestAnimationFrame(() => {
      pendingFocusRef.current = null;
    });
  }, []);

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const root = rootRef.current;
    const target =
      cardElement(root, pending.id) ??
      cardElement(root, pending.fallback) ??
      root?.querySelector<HTMLElement>("[data-home-board]") ??
      null;
    target?.focus({ preventScroll: true });
  });

  const moveFocus = useCallback((id: string) => {
    cardElement(rootRef.current, id)?.focus();
  }, []);

  const findAction = useCallback((id: string) => actions.find((item) => item.id === id), [actions]);

  const mutate = useCallback(
    (action: ActionItem, mutation: HomeMutation) => {
      keepFocus(action.id, successorId(liveBoard, action.id));
      void run(action.id, mutation);
    },
    [keepFocus, liveBoard, run],
  );

  // In a browser, reminders that fired show up here as a quiet toast with the card's own choices.
  const showReminder = useCallback(
    (reminder: ReminderItem) => {
      const content = reminderToast(reminder, {
        now: () => (now ? now() : new Date()),
        timeZone: zone,
        apply: (id, mutation) => {
          void (async () => {
            if (!actionsRef.current.some((item) => item.id === id)) await refresh();
            void run(id, mutation);
          })();
        },
      });
      showToast(content.message, undefined, { detail: content.detail, actions: content.actions });
    },
    [now, refresh, run, showToast, zone],
  );
  const { checkins } = useReminderFeed({ bundleId, onReminder: showReminder });
  const checkinMap = useMemo(() => new Map(checkins.map((item) => [item.actionId, item.since])), [checkins]);

  // A clicked notification names the card to land on; it may still be loading, so wait for it to appear.
  const [wantedId, setWantedId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusAction?.id) return;
    setWantedId(focusAction.id);
    void refresh();
    const giveUp = window.setTimeout(() => setWantedId(null), 6_000);
    return () => window.clearTimeout(giveUp);
  }, [focusAction, refresh]);

  const drag = useBoardDrag({
    today: liveBoard.today,
    findAction,
    onMove: (action, move) => mutate(action, move.mutation),
  });

  // The columns hold still while a card is in the air, even if a refresh arrives.
  const board = drag.draggingId && frozen ? frozen : liveBoard;
  const dragging = drag.draggingId !== null;
  useEffect(() => {
    setFrozen((current) => (dragging ? (current ?? liveBoard) : null));
    // The board is captured once, when the drag starts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const cardIds = useMemo(
    () => boardGroups(board).flatMap((group) => group.entries.map((entry) => entry.action.id)),
    [board],
  );
  const tabbableId = cursorId && cardIds.includes(cursorId) ? cursorId : (cardIds[0] ?? null);
  useEffect(() => {
    if (!wantedId) return;
    const card = cardElement(rootRef.current, wantedId);
    if (!card) return;
    card.scrollIntoView?.({ block: "nearest" });
    card.focus({ preventScroll: true });
    setWantedId(null);
  }, [cardIds, wantedId]);

  const env: BoardEnv = useMemo(
    () => ({
      titleForNote,
      presets: snoozePresets(clock, zone),
      editingId,
      snoozeId,
      tabbableId,
      drag,
      setEditingId: (id) => {
        if (!id && editingId) keepFocus(editingId, null);
        setEditingId(id);
      },
      setSnoozeId: (id) => {
        if (!id && snoozeId) keepFocus(snoozeId, null);
        setSnoozeId(id);
      },
      onMutate: mutate,
      onSnoozePhrase: (action, phrase) => snoozeWithPhrase(action.id, phrase),
      onOpenSource,
      onClearNote: (action) => {
        if (action.anchor?.noteId) void clearNote(action.anchor.noteId, titleForNote(action.anchor.noteId));
      },
      checkins: checkinMap,
    }),
    [
      checkinMap, clearNote, clock, drag, editingId, keepFocus, mutate, onOpenSource, snoozeId, snoozeWithPhrase,
      tabbableId, titleForNote, zone,
    ],
  );

  function handOff(send: (groupId: string, text: string) => void) {
    const text = capture.text;
    if (!text.trim()) return;
    capture.clear();
    send(groupId, text);
  }

  const greeting = loaded ? homeGreeting(board, clock, zone) : null;

  return (
    <div
      ref={rootRef}
      className="home-view"
      data-home-view=""
      data-layout={layout}
      tabIndex={-1}
      aria-label="Home"
      onFocusCapture={(event) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>("[data-board-card]");
        if (card?.dataset.actionId) setCursorId(card.dataset.actionId);
      }}
      onFocus={refreshSoon}
    >
      <div className="home-inner">
        <HomeHeader greeting={greeting} />
        <HomeCapture
          text={capture.text}
          active={active}
          focusRequest={focusRequest}
          onChange={capture.change}
          onFile={() => handOff(onFileCapture)}
          onOpenAsDraft={() => handOff(onOpenAsDraft)}
        />
        {!loaded && unavailable && (
          <p className="home-empty">Your actions will show up here as soon as they're ready.</p>
        )}
        <HomeBoard board={board} env={env} layout={layout} moveFocus={moveFocus} />
        {/* A short summary written by the local model can fill this slot later. */}
        <div data-home-summary-slot="" hidden />
      </div>
      <LetGoZone drag={drag} />
      <HomeToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
