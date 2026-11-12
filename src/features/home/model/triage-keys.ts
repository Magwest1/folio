export type BoardCommand =
  | { type: "focus"; direction: "next" | "previous" }
  | { type: "move"; to: "earlier" | "later" | "loose" }
  | { type: "accept" | "done" | "edit" | "snooze" | "not-an-action" | "not-important" | "open-source" };

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const PLAIN: Record<string, BoardCommand> = {
  j: { type: "focus", direction: "next" },
  ArrowDown: { type: "focus", direction: "next" },
  k: { type: "focus", direction: "previous" },
  ArrowUp: { type: "focus", direction: "previous" },
  a: { type: "accept" },
  d: { type: "done" },
  e: { type: "edit" },
  s: { type: "snooze" },
  x: { type: "not-an-action" },
  n: { type: "not-important" },
  Enter: { type: "open-source" },
};

const SHIFTED: Record<string, BoardCommand> = {
  ArrowUp: { type: "move", to: "earlier" },
  ArrowDown: { type: "move", to: "later" },
  // Left and right are aliases for the previous and next bucket.
  ArrowLeft: { type: "move", to: "earlier" },
  ArrowRight: { type: "move", to: "later" },
  End: { type: "move", to: "loose" },
};

/** Board keys. They only apply while focus is inside the board and never while typing. */
export function boardCommand(event: KeyEvent): BoardCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (event.shiftKey ? SHIFTED : PLAIN)[event.key] ?? null;
}

export const BOARD_HINT =
  "↑↓ or j/k move · Shift+↑↓ move it to another day · d done · a accept · e edit · s snooze · x not an action · n not important";
