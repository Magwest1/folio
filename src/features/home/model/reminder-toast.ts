import type { ReminderItem } from "../../../domain/types.ts";
import type { HomeMutation } from "./action-mutations.ts";
import { snoozePresets } from "./snooze-presets.ts";

export type ReminderToastAction = { label: string; run: () => void };
export type ReminderToastContent = { message: string; detail: string; actions: ReminderToastAction[] };

type Deps = {
  /** Applies a choice to the reminder's action, exactly as the card's own buttons would. */
  apply: (actionId: string, mutation: HomeMutation) => void;
  now: () => Date;
  timeZone: string;
};

/**
 * What an in-app reminder offers. One item gets the same three choices as a native notification;
 * several items (a merged reminder or the morning brief) only get a dismiss, since a single click
 * must never let go of things the user has not looked at.
 */
export function reminderToast(reminder: ReminderItem, { apply, now, timeZone }: Deps): ReminderToastContent {
  const [id] = reminder.actionIds;
  const single = reminder.kind === "action" && reminder.actionIds.length === 1 && id;
  if (!single) return { message: reminder.title, detail: reminder.body, actions: [{ label: "Dismiss", run: () => undefined }] };
  return {
    message: reminder.title,
    detail: reminder.body,
    actions: [
      { label: "Done", run: () => apply(id, { type: "done" }) },
      {
        label: "Snooze",
        run: () => {
          const tomorrow = snoozePresets(now(), timeZone).find((preset) => preset.id === "tomorrow-morning");
          if (tomorrow) apply(id, { type: "snooze", until: tomorrow.until, label: tomorrow.label });
        },
      },
      { label: "Not important", run: () => apply(id, { type: "not-important" }) },
    ],
  };
}
