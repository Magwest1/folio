export type TriageCommand =
  | "next"
  | "previous"
  | "accept"
  | "edit"
  | "snooze"
  | "not-an-action"
  | "not-important";

/** Keys only work while the To confirm list has focus, so typing is never hijacked. */
export const TRIAGE_KEYS: Record<string, TriageCommand> = {
  j: "next",
  ArrowDown: "next",
  k: "previous",
  ArrowUp: "previous",
  a: "accept",
  e: "edit",
  s: "snooze",
  x: "not-an-action",
  n: "not-important",
};

export function triageCommand(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): TriageCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return TRIAGE_KEYS[event.key] ?? null;
}

export const TRIAGE_HINT = "j/k move · a accept · e edit · s snooze · x not an action · n not important";
