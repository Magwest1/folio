import type { ActionItem, ActionPatch, ActionStatus, ActionTransition } from "../../../domain/types.ts";

/** What the user chose on a card. Each maps to one server transition. */
export type HomeMutation =
  | { type: "accept" }
  | { type: "done" }
  | { type: "reopen" }
  | { type: "snooze"; until: string; label: string }
  | { type: "not-important" }
  | { type: "not-an-action" }
  | { type: "edit"; patch: ActionPatch }
  | { type: "remove-auto-added" };

export const TRANSITION_FOR: Record<Exclude<HomeMutation["type"], "edit">, ActionTransition> = {
  accept: "confirm",
  done: "complete",
  reopen: "reopen",
  snooze: "snooze",
  "not-important": "let-go",
  "not-an-action": "reject",
  "remove-auto-added": "reject",
};

const STATUS_FOR: Record<Exclude<HomeMutation["type"], "edit" | "snooze" | "remove-auto-added">, ActionStatus> = {
  accept: "open",
  done: "done",
  reopen: "open",
  "not-important": "let-go",
  "not-an-action": "rejected",
};

/** Short, kind wording for the undo toast. Never guilt, never a count. */
export function toastLabel(mutation: HomeMutation): string {
  switch (mutation.type) {
    case "accept":
      return "Added to your list.";
    case "done":
      return "Marked done.";
    case "reopen":
      return "Brought back.";
    case "snooze":
      return `Snoozed until ${mutation.label.toLowerCase()}.`;
    case "not-important":
      return "Let go. It won't come back.";
    case "not-an-action":
      return "Noted. It isn't an action.";
    case "edit":
      return "Saved.";
    case "remove-auto-added":
      return "Removed. It won't come back.";
  }
}

/** The card as it will look once the server agrees, so the UI never waits. */
export function applyOptimistic(action: ActionItem, mutation: HomeMutation, now: Date): ActionItem {
  const at = now.toISOString();
  if (mutation.type === "edit")
    return { ...action, ...mutation.patch, editedByUser: true, updatedAt: at, touchedAt: at };
  const to: ActionStatus =
    mutation.type === "snooze"
      ? "snoozed"
      : mutation.type === "remove-auto-added"
        ? "rejected"
        : STATUS_FOR[mutation.type];
  return {
    ...action,
    status: to,
    snoozedUntil: mutation.type === "snooze" ? mutation.until : null,
    updatedAt: at,
    touchedAt: at,
    history: [...action.history, { at, from: action.status, to, by: "user" }],
  };
}
