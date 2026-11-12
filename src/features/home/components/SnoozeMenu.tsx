import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SnoozePreset } from "../model/snooze-presets.ts";

type SnoozeMenuProps = {
  presets: SnoozePreset[];
  label: string;
  onPick: (preset: SnoozePreset) => void;
  /** Snoozes with the user's own words. Resolves to a friendly error to show, or null when it worked. */
  onPhrase: (phrase: string) => Promise<string | null>;
  onClose: () => void;
};

const NAVIGABLE = "[role=menuitem], input";

/** Three plain choices, and a small field for anything else: "tomorrow after lunch", "neste uke". */
export function SnoozeMenu({ presets, label, onPick, onPhrase, onClose }: SnoozeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = phrase.trim();
    if (!text || busy) return;
    setBusy(true);
    const problem = await onPhrase(text);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  }

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  /** Pinned to the button, so a scrolling board or a narrow column never clips it. */
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
      className="home-snooze-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        // Digits typed into the field are words, not shortcuts.
        const typing = event.target instanceof HTMLInputElement;
        const preset = typing ? undefined : presets[Number(event.key) - 1];
        if (preset) {
          event.preventDefault();
          event.stopPropagation();
          onPick(preset);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(NAVIGABLE) ?? [])];
          const index = items.indexOf(document.activeElement as HTMLElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          items[(index + step + items.length) % items.length]?.focus();
        }
      }}
    >
      {presets.map((preset, index) => (
        <button key={preset.id} type="button" role="menuitem" onClick={() => onPick(preset)}>
          <span>{preset.label}</span>
          <kbd aria-hidden="true">{index + 1}</kbd>
        </button>
      ))}
      <form
        className="home-snooze-phrase"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          value={phrase}
          maxLength={120}
          placeholder="tomorrow after lunch, neste uke…"
          aria-label="Snooze until, in your own words"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={busy}
          onChange={(event) => {
            setPhrase(event.target.value);
            setError(null);
          }}
        />
        {error && (
          <p id={errorId} className="home-snooze-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
