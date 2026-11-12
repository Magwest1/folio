import { useEffect, useRef, useState } from "react";
import type { ReminderCheckin, ReminderItem } from "../../../domain/types.ts";
import { ackReminder, fetchPendingReminders } from "../../../lib/api.ts";

type Options = {
  /** Poll only while Home is on screen. */
  visible?: boolean;
  bundleId?: string;
  pollMs?: number;
  /** Called once for each reminder this window is responsible for showing. */
  onReminder: (reminder: ReminderItem) => void;
};

/** Whether the desktop shell is already showing reminders as system notifications. */
async function deliveredNatively(): Promise<boolean> {
  try {
    return (await window.folio?.reminders?.deliversNatively()) === true;
  } catch {
    return false;
  }
}

/**
 * Asks the server what is waiting: reminders that fired and the "still relevant?" prompts. In a browser
 * (or when the system cannot notify) each reminder is shown here once and acknowledged, so it is never
 * repeated; when the desktop shell has already shown it, nothing appears here.
 */
export function useReminderFeed({ visible = true, bundleId, pollMs = 30_000, onReminder }: Options) {
  const [checkins, setCheckins] = useState<ReminderCheckin[]>([]);
  const shownRef = useRef(new Set<string>());
  const handlerRef = useRef(onReminder);
  useEffect(() => {
    handlerRef.current = onReminder;
  });

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    async function poll() {
      if (document.visibilityState === "hidden") return;
      try {
        const [pending, native] = await Promise.all([fetchPendingReminders(), deliveredNatively()]);
        if (cancelled) return;
        setCheckins(Array.isArray(pending?.checkins) ? pending.checkins : []);
        if (native) return;
        for (const reminder of Array.isArray(pending?.reminders) ? pending.reminders : []) {
          if (shownRef.current.has(reminder.id)) continue;
          shownRef.current.add(reminder.id);
          handlerRef.current(reminder);
          void ackReminder(reminder.id).catch(() => shownRef.current.delete(reminder.id));
        }
      } catch {
        // Reminders are a nicety; Home works without them.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), pollMs);
    window.addEventListener("focus", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [bundleId, pollMs, visible]);

  return { checkins };
}
