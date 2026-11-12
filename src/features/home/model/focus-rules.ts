/**
 * Home may take focus only when nothing else is being used. A focused draft,
 * editor or input always wins; the tab strip and the page itself do not count.
 */
export function homeMayTakeFocus(active: Element | null, home: Element | null): boolean {
  if (!active || active === document.body || active === document.documentElement) return true;
  if (home?.contains(active)) return true;
  return active.closest(".editor-tabs") !== null;
}

export function modifierLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl+";
}

/** Typing surfaces and open menus keep their keys; board shortcuts never fire there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.closest("[role=menu], form") !== null)
  );
}

/** Drag-to-scroll starts on empty timeline space, never on a card, a control or a menu. */
export function canDragScrollFrom(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-board-card], button, a, input, textarea, select, summary, [role=menu], [draggable=true]") === null
  );
}
