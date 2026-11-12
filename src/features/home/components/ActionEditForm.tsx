import { useEffect, useId, useRef, useState } from "react";
import type { ActionItem, ActionPatch } from "../../../domain/types.ts";

type ActionEditFormProps = {
  action: ActionItem;
  onSave: (patch: ActionPatch) => void;
  onCancel: () => void;
};

const startDate = (action: ActionItem) =>
  !action.due ? "" : "window" in action.due ? action.due.window.start : action.due.date;

/** Inline editing: wording, person and day. Enter saves, Escape cancels. */
export function ActionEditForm({ action, onSave, onCancel }: ActionEditFormProps) {
  const id = useId();
  const [text, setText] = useState(action.text);
  const [person, setPerson] = useState(action.person ?? "");
  const [date, setDate] = useState(startDate(action));
  const textRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  function save() {
    const patch: ActionPatch = {};
    if (text.trim() && text.trim() !== action.text) patch.text = text.trim();
    if ((person.trim() || null) !== action.person) patch.person = person.trim() || null;
    // A multi-day window is only replaced when the day is changed on purpose.
    if (date !== startDate(action)) patch.due = date ? { date } : null;
    if (Object.keys(patch).length) onSave(patch);
    else onCancel();
  }

  return (
    <form
      className="home-edit-form"
      aria-label="Edit action"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label htmlFor={`${id}-text`}>What</label>
      <input
        id={`${id}-text`}
        ref={textRef}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div className="home-edit-row">
        <div>
          <label htmlFor={`${id}-person`}>Who</label>
          <input id={`${id}-person`} value={person} onChange={(event) => setPerson(event.currentTarget.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-date`}>When</label>
          <input id={`${id}-date`} type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} />
        </div>
      </div>
      <div className="home-edit-buttons">
        <button type="button" className="home-quiet-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="home-primary-button">
          Save
        </button>
      </div>
    </form>
  );
}
