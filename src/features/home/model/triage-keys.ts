export type BoardCommand =
  | { type: "focus"; direction: "next" | "previous" | "left" | "right" }
  | { type: "move"; to: "earlier" | "later" | "loose" }
  | { type: "accept" | "done" | "edit" | "snooze" | "not-an-action" | "not-important" | "open-source" };

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const PLAIN: Record<string, BoardCommand> = {
  j: { type: "focus", direction: "next" },
  ArrowDown: { type: "focus", direction: "next" },
  k: { type: "focus", direction: "previous" },
  ArrowUp: { type: "focus", direction: "previous" },
  ArrowLeft: { type: "focus", direction: "left" },
  ArrowRight: { type: "focus", direction: "right" },
  a: { type: "accept" },
  d: { type: "done" },
  e: { type: "edit" },
  s: { type: "snooze" },
  x: { type: "not-an-action" },
  n: { type: "not-important" },
  Enter: { type: "open-source" },
};

const SHIFTED: Record<string, BoardCommand> = {
  ArrowLeft: { type: "move", to: "earlier" },
  ArrowRight: { type: "move", to: "later" },
  ArrowDown: { type: "move", to: "loose" },
};

/** Board keys. They only apply while focus is inside the board and never while typing. */
export function boardCommand(event: KeyEvent): BoardCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (event.shiftKey ? SHIFTED : PLAIN)[event.key] ?? null;
}

export const BOARD_HINT =
  "Arrows or j/k move · Shift+arrows move a day · d done · a accept · e edit · s snooze · x not an action · n not important";
