import { useEffect, useRef } from "react";
import type { SnoozePreset } from "../model/snooze-presets.ts";

type SnoozeMenuProps = {
  presets: SnoozePreset[];
  label: string;
  onPick: (preset: SnoozePreset) => void;
  onClose: () => void;
};

/** Three plain choices. Typing a date in words comes later. */
export function SnoozeMenu({ presets, label, onPick, onClose }: SnoozeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

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
        const preset = presets[Number(event.key) - 1];
        if (preset) {
          event.preventDefault();
          event.stopPropagation();
          onPick(preset);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
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
    </div>
  );
}
