import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { homeMayTakeFocus, modifierLabel } from "../model/focus-rules.ts";

type HomeCaptureProps = {
  text: string;
  /** This pane is the active group, so it may claim focus when nothing else holds it. */
  active: boolean;
  /** Bumps when the user explicitly opens Home, which is allowed to take focus. */
  focusRequest: number;
  onChange: (text: string) => void;
  onFile: () => void;
  onOpenAsDraft: () => void;
};

/** The first thing on Home: a plain field that is ready to type into. */
export function HomeCapture({ text, active, focusRequest, onChange, onFile, onOpenAsDraft }: HomeCaptureProps) {
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef(focusRequest);
  const mod = modifierLabel();
  const empty = !text.trim();

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const explicit = lastRequestRef.current !== focusRequest;
    lastRequestRef.current = focusRequest;
    if (explicit || (active && homeMayTakeFocus(document.activeElement, field.closest("[data-home-view]"))))
      field.focus({ preventScroll: true });
    // Focus is decided once per mount or explicit request, never on later renders.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight + 2, 360)}px`;
  }, [text]);

  return (
    <section className="home-capture" aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} htmlFor={`${id}-field`} className="home-capture-label">
        Capture
      </label>
      <textarea
        id={`${id}-field`}
        ref={fieldRef}
        className="home-capture-field"
        rows={2}
        value={text}
        placeholder="What's on your mind?"
        aria-describedby={`${id}-hint`}
        spellCheck
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.blur();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          if (event.shiftKey) onOpenAsDraft();
          else onFile();
        }}
      />
      <div className="home-capture-actions">
        <p id={`${id}-hint`} className="home-capture-hint">
          Enter for a new line. {mod}↵ files it. {mod}⇧↵ opens it as a draft.
        </p>
        <button type="button" className="home-quiet-button" disabled={empty} onClick={onOpenAsDraft}>
          Open as draft
        </button>
        <button type="button" className="home-primary-button" disabled={empty} onClick={onFile}>
          File it
        </button>
      </div>
    </section>
  );
}
