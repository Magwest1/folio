import { useEffect, useRef, useState } from "react";
import type { HomeEntry } from "../model/home-sections.ts";
import { triageCommand, TRIAGE_HINT } from "../model/triage-keys.ts";
import { HomeCardItem, type HomeCardEnv } from "./HomeSectionList.tsx";

type HomeConfirmListProps = {
  entries: HomeEntry[];
  env: HomeCardEnv;
};

const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest("[role=menu]") !== null);

/**
 * Suggestions waiting for a yes or no. The keys below work only while this
 * list has focus, so they can never fire while the user is writing.
 */
export function HomeConfirmList({ entries, env }: HomeConfirmListProps) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.min(cursor, Math.max(0, entries.length - 1));
  const current = entries[index];

  useEffect(() => {
    if (current) document.getElementById(`home-confirm-${current.action.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  if (!entries.length) return null;

  return (
    <section className="home-section" aria-labelledby="home-to-confirm">
      <h2 id="home-to-confirm" className="home-section-title">
        To confirm
      </h2>
      <div
        ref={listRef}
        className="home-confirm"
        role="group"
        data-home-region=""
        tabIndex={0}
        aria-label="Suggestions to confirm"
        aria-describedby="home-confirm-hint"
        aria-activedescendant={current ? `home-confirm-${current.action.id}` : undefined}
        onKeyDown={(event) => {
          if (typing(event.target) || event.nativeEvent.isComposing) return;
          const command = triageCommand(event);
          if (!command || !current) return;
          event.preventDefault();
          const { action } = current;
          if (command === "next") setCursor(Math.min(entries.length - 1, index + 1));
          else if (command === "previous") setCursor(Math.max(0, index - 1));
          else if (command === "accept") env.onMutate(action, { type: "accept" });
          else if (command === "edit") env.setEditingId(action.id);
          else if (command === "snooze") env.setSnoozeId(action.id);
          else if (command === "not-an-action") env.onMutate(action, { type: "not-an-action" });
          else env.onMutate(action, { type: "not-important" });
        }}
        onFocus={(event) => {
          const card = (event.target as HTMLElement).closest("[data-home-card]");
          const at = entries.findIndex((entry) => `home-confirm-${entry.action.id}` === card?.id);
          if (at !== -1) setCursor(at);
        }}
      >
        <p id="home-confirm-hint" className="home-confirm-hint">
          {TRIAGE_HINT}
        </p>
        <ul className="home-card-list">
          {entries.map((entry, position) => (
            <HomeCardItem
              key={entry.action.id}
              entry={entry}
              env={env}
              mode="suggested"
              selected={position === index}
              elementId={`home-confirm-${entry.action.id}`}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
