import { useEffect, useLayoutEffect, useRef } from "react";

export type SourceChoice = { key: string; title: string };

type SourceMenuProps = {
  label: string;
  choices: SourceChoice[];
  onPick: (index: number) => void;
  onClose: () => void;
};

/** The notes that mention one commitment, first the one it came from. Opens a note on pick. */
export function SourceMenu({ label, choices, onPick, onClose }: SourceMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  /** Pinned to the button, like the snooze menu, so a narrow column never clips it. */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement?.getBoundingClientRect();
    if (!menu || !anchor) return;
    const { width, height } = menu.getBoundingClientRect();
    const below = anchor.bottom + 4;
    menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : below}px`;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
  }, []);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeRef.current();
    };
    const scrolled = () => closeRef.current();
    document.addEventListener("mousedown", away);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      className="home-snooze-menu home-source-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {choices.map((choice, index) => (
        <button key={choice.key} type="button" role="menuitem" onClick={() => onPick(index)}>
          {choice.title}
        </button>
      ))}
    </div>
  );
}
