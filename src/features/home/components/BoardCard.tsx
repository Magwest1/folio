import type { ReactNode } from "react";
import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import type { BoardDrag } from "../hooks/useBoardDrag.ts";
import type { HomeMutation } from "../model/action-mutations.ts";
import type { SnoozePreset } from "../model/snooze-presets.ts";
import type { BoardEntry } from "../model/week-board.ts";
import { ActionEditForm } from "./ActionEditForm.tsx";
import { BoardIcon, type BoardIconName } from "./BoardIcons.tsx";
import { SnoozeMenu } from "./SnoozeMenu.tsx";

/** Everything a card needs from Home, so columns and the tray stay thin. */
export type BoardEnv = {
  titleForNote: (noteId: string | null | undefined) => string | null;
  presets: SnoozePreset[];
  editingId: string | null;
  snoozeId: string | null;
  /** The one card that sits in the tab order; arrows move it. */
  tabbableId: string | null;
  drag: BoardDrag;
  setEditingId: (id: string | null) => void;
  setSnoozeId: (id: string | null) => void;
  onMutate: (action: ActionItem, mutation: HomeMutation) => void;
  onSnoozePhrase: (action: ActionItem, phrase: string) => Promise<string | null>;
  onOpenSource: (action: ActionItem) => void;
  onClearNote: (action: ActionItem) => void;
  /** Items Folio has asked "still relevant?" about, by action id. Quiet text on the card, never a badge. */
  checkins: ReadonlyMap<string, string>;
};

type BoardCardProps = {
  entry: BoardEntry;
  env: BoardEnv;
  /** "card" fills a column, "chip" is the compact form for the tray and window bands. */
  variant: "card" | "chip";
};

function IconButton({
  label,
  icon,
  tone,
  onClick,
  expanded,
}: {
  label: string;
  icon: BoardIconName;
  tone?: "primary";
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={`board-icon-button${tone ? ` is-${tone}` : ""}`}
      aria-label={label}
      title={label}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <BoardIcon name={icon} />
    </button>
  );
}

export function BoardCard({ entry, env, variant }: BoardCardProps) {
  const { action } = entry;
  const sourceTitle = env.titleForNote(action.anchor?.noteId);
  const canOpenSource = Boolean(action.anchor?.noteId);
  const editing = env.editingId === action.id;
  const snoozeOpen = env.snoozeId === action.id;
  const faded = entry.placement === "faded";
  const live = !faded && !entry.completed;
  const draggable = live && !editing && !snoozeOpen;
  const mutate = (mutation: HomeMutation) => env.onMutate(action, mutation);
  // Asked once; answering (which touches the item) or any later edit makes the line go away.
  const askedAt = env.checkins.get(action.id);
  const asked = live && askedAt !== undefined && Date.parse(action.touchedAt) <= Date.parse(askedAt);

  const person = [action.person, entry.waitingLabel].filter(Boolean).join(" · ");
  const meta: ReactNode[] = [
    entry.timeLabel,
    entry.dateLabel,
    person || null,
    entry.reminder ? "back from snooze" : null,
    canOpenSource && sourceTitle ? `from ${sourceTitle}` : null,
  ].filter(Boolean);

  const classes = [
    "board-card",
    `is-${variant}`,
    entry.suggested && "is-suggested",
    entry.completed && "is-completed",
    faded && "is-faded",
    action.kind === "waiting-on" && "is-waiting",
    editing && "is-editing",
    snoozeOpen && "has-menu",
    env.drag.draggingId === action.id && "is-dragging",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={classes}
      data-board-card=""
      data-action-id={action.id}
      tabIndex={env.tabbableId === action.id ? 0 : -1}
      draggable={draggable}
      onDragStart={draggable ? (event) => env.drag.start(event, action) : undefined}
      onDragEnd={env.drag.end}
    >
      {editing ? (
        <ActionEditForm
          action={action}
          onCancel={() => env.setEditingId(null)}
          onSave={(patch: ActionPatch) => {
            env.setEditingId(null);
            mutate({ type: "edit", patch });
          }}
        />
      ) : (
        <>
          {entry.suggested && <span className="board-card-flag">suggested</span>}
          <p className="board-card-text" title={variant === "chip" ? action.text : undefined}>
            {action.text}
          </p>
          <div className={`board-card-foot${meta.length ? "" : " is-bare"}`}>
            {meta.length > 0 && (
              <p className="board-card-meta">
                {meta.map((item, index) => (
                  <span key={index}>{item}</span>
                ))}
              </p>
            )}
            <div className="board-card-actions" role="group" aria-label={`Actions for ${action.text}`}>
              {entry.suggested ? (
                <IconButton label="Accept" icon="accept" tone="primary" onClick={() => mutate({ type: "accept" })} />
              ) : live ? (
                <IconButton label="Done" icon="check" tone="primary" onClick={() => mutate({ type: "done" })} />
              ) : (
                <IconButton label="Bring back" icon="restore" tone="primary" onClick={() => mutate({ type: "reopen" })} />
              )}
              {live && (
                <span className="board-snooze-wrap">
                  <IconButton
                    label="Snooze"
                    icon="snooze"
                    expanded={snoozeOpen}
                    onClick={() => env.setSnoozeId(snoozeOpen ? null : action.id)}
                  />
                  {snoozeOpen && (
                    <SnoozeMenu
                      presets={env.presets}
                      label={`Snooze ${action.text}`}
                      onClose={() => env.setSnoozeId(null)}
                      onPhrase={(phrase) => env.onSnoozePhrase(action, phrase)}
                      onPick={(preset) => {
                        env.setSnoozeId(null);
                        mutate({ type: "snooze", until: preset.until, label: preset.label });
                      }}
                    />
                  )}
                </span>
              )}
              {live && <IconButton label="Edit" icon="edit" onClick={() => env.setEditingId(action.id)} />}
              {canOpenSource && <IconButton label="Open source" icon="source" onClick={() => env.onOpenSource(action)} />}
              {canOpenSource && live && (
                <IconButton label="Clear actions from this note" icon="clear-note" onClick={() => env.onClearNote(action)} />
              )}
              {entry.suggested && (
                <IconButton label="Not an action" icon="not-action" onClick={() => mutate({ type: "not-an-action" })} />
              )}
              <IconButton label="Not important" icon="dismiss" onClick={() => mutate({ type: "not-important" })} />
            </div>
          </div>
          {asked && (
            <p className="board-card-checkin">
              Still relevant?{" "}
              <button
                type="button"
                className="home-link-button"
                aria-label={`Keep ${action.text}`}
                onClick={() => mutate({ type: "keep" })}
              >
                Keep
              </button>
              <button
                type="button"
                className="home-link-button"
                aria-label={`Let go of ${action.text}`}
                onClick={() => mutate({ type: "not-important" })}
              >
                Let go
              </button>
            </p>
          )}
          {entry.recentlyAdded && (
            <p className="board-card-added">
              added from {sourceTitle ?? "a note"} ·{" "}
              <button
                type="button"
                className="home-link-button"
                aria-label={`Undo adding ${action.text}`}
                onClick={() => mutate({ type: "remove-auto-added" })}
              >
                undo
              </button>
            </p>
          )}
        </>
      )}
    </li>
  );
}
