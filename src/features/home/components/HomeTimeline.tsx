import { useId, useMemo, useRef, type KeyboardEvent } from "react";
import { useTimelineScroll } from "../hooks/useTimelineScroll.ts";
import type { TimelineFit } from "../hooks/useTimelineFit.ts";
import { neighbourId } from "../model/board-focus.ts";
import { moveForKey } from "../model/board-moves.ts";
import { isTypingTarget } from "../model/focus-rules.ts";
import { timelineSections, type TimelineSection } from "../model/timeline.ts";
import { BOARD_HINT, boardCommand } from "../model/triage-keys.ts";
import { boardGroups, type BoardEntry, type WeekBoard } from "../model/week-board.ts";
import { BoardCard, type BoardEnv } from "./BoardCard.tsx";

type HomeTimelineProps = {
  board: WeekBoard;
  env: BoardEnv;
  fit: TimelineFit;
  focusRequest: number;
  /** Put the keyboard on a card right now. */
  moveFocus: (id: string) => void;
};

function findEntry(board: WeekBoard, id: string): BoardEntry | undefined {
  return boardGroups(board)
    .flatMap((group) => group.entries)
    .concat(board.faded)
    .find((entry) => entry.action.id === id);
}

function Cards({ entries, env, label }: { entries: BoardEntry[]; env: BoardEnv; label?: string }) {
  if (!entries.length) return null;
  return (
    <ul className="timeline-cards" role="list" aria-label={label}>
      {entries.map((entry) => (
        <BoardCard key={entry.action.id} entry={entry} env={env} />
      ))}
    </ul>
  );
}

function Divider({ id, label, as: Tag = "h2" }: { id: string; label: string; as?: "h2" | "summary" }) {
  return (
    <Tag id={Tag === "h2" ? `timeline-${id}` : undefined} className="timeline-divider" data-timeline-divider={id} data-label={label}>
      <span className="timeline-tick" aria-hidden="true" />
      <span className="timeline-divider-label">{label}</span>
    </Tag>
  );
}

function Section({ section, env }: { section: TimelineSection; env: BoardEnv }) {
  const key = `section:${section.id}`;
  const empty = section.entries.length === 0 && section.earlier.length === 0;
  const crowded = section.earlier.length > 0 && section.entries.length > 0;
  if (section.kind === "faded")
    return (
      <details className="timeline-section is-faded">
        <Divider id={section.id} label={section.label} as="summary" />
        <Cards entries={section.entries} env={env} />
      </details>
    );
  const drop = section.drop ? env.drag.target(key, section.drop) : {};
  return (
    <section
      className={[
        "timeline-section",
        `is-${section.kind}`,
        section.column?.isToday && "is-today",
        section.column?.weekend && "is-weekend",
        empty && "is-empty",
        section.drop && env.drag.draggingId && "is-target",
        env.drag.overKey === key && "is-over",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={`timeline-${section.id}`}
      data-section={section.id}
      data-date={section.column?.start}
      data-end={section.column?.end ?? undefined}
      data-column={section.column?.kind}
      {...drop}
    >
      <Divider id={section.id} label={section.label} />
      {section.earlier.map((group) => (
        <div key={group.date} className="timeline-earlier">
          <p className="timeline-subdivider">{group.label}</p>
          <Cards entries={group.entries} env={env} label={`Due ${group.label}`} />
        </div>
      ))}
      {crowded ? (
        <div className="timeline-earlier is-today-group">
          <p className="timeline-subdivider">today</p>
          <Cards entries={section.entries} env={env} label="Due today" />
        </div>
      ) : (
        <Cards entries={section.entries} env={env} />
      )}
      {empty && <div className="timeline-empty" aria-hidden="true" />}
    </section>
  );
}

/**
 * One continuous vertical list in time order, with gray dividers, a thin tick rail and a sticky
 * day label, in the same family as the history timeline. Keys apply only while focus is on a card
 * inside it, and never while typing, so the writing field stays untouched.
 */
export function HomeTimeline({ board, env, fit, focusRequest, moveFocus }: HomeTimelineProps) {
  const hintId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => timelineSections(board, env.drag.draggingId !== null), [board, env.drag.draggingId]);
  const { stickyLabel, effects, handlers } = useTimelineScroll({
    scrollerRef,
    ownsScroll: fit === "timeline",
    dividersKey: sections.map((section) => `${section.id}:${section.label}`).join("|"),
    dragging: env.drag.draggingId !== null,
    focusRequest,
  });

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || isTypingTarget(event.target)) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-board-card]");
    const id = element?.dataset.actionId;
    const command = boardCommand(event);
    if (!command) return;
    if (!element && command.type === "focus" && event.target === event.currentTarget) {
      // Focus rests on the timeline itself after a card leaves; arrows pick the thread back up.
      const first = neighbourId(board, null, command.direction);
      if (first) {
        event.preventDefault();
        moveFocus(first);
      }
      return;
    }
    if (!element || !id) return;
    const entry = findEntry(board, id);
    if (!entry) return;
    const { action } = entry;
    const live = !entry.completed && entry.placement !== "faded";
    const onCard = event.target === element;

    if (command.type === "focus") {
      event.preventDefault();
      const next = neighbourId(board, id, command.direction);
      if (next) moveFocus(next);
      return;
    }
    if (command.type === "open-source") {
      // Enter on a button inside the card belongs to the button.
      if (!onCard || !action.anchor?.noteId) return;
      event.preventDefault();
      env.onOpenSource(action);
      return;
    }
    const act = (run: () => void) => {
      event.preventDefault();
      run();
    };
    if (command.type === "move") {
      const move = live ? moveForKey(entry, command.to, board) : null;
      if (move) act(() => env.onMutate(action, move.mutation));
      return;
    }
    if (command.type === "not-important") return act(() => env.onMutate(action, { type: "not-important" }));
    if (entry.placement === "faded") {
      if (command.type === "accept") act(() => env.onMutate(action, { type: "reopen" }));
      return;
    }
    if (entry.completed) return;
    if (command.type === "accept" && entry.suggested) act(() => env.onMutate(action, { type: "accept" }));
    else if (command.type === "not-an-action" && entry.suggested)
      act(() => env.onMutate(action, { type: "not-an-action" }));
    else if (command.type === "done" && !entry.suggested) act(() => env.onMutate(action, { type: "done" }));
    else if (command.type === "edit") act(() => env.setEditingId(id));
    else if (command.type === "snooze") act(() => env.setSnoozeId(id));
  }

  return (
    <>
      <div className="home-timeline-wrap" data-fit={fit}>
        {stickyLabel && (
          <div className="timeline-sticky" aria-hidden="true">
            <span className="timeline-tick is-sticky-tick" />
            <span>{stickyLabel}</span>
          </div>
        )}
        <div
          ref={scrollerRef}
          className={`home-timeline${env.drag.draggingId ? " is-dragging" : ""}`}
          data-home-board=""
          data-effects={effects ? "on" : "off"}
          tabIndex={-1}
          aria-label="Timeline"
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          {...handlers}
        >
          <div className="home-column">
            <div className="timeline-list">
              {sections.map((section) => (
                <Section key={section.id} section={section} env={env} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="home-column">
        <p id={hintId} className="board-hint">
          {BOARD_HINT}
        </p>
      </div>
    </>
  );
}
