import type { ActionItem, ActionPatch } from "../../../domain/types.ts";
import type { HomeMutation } from "../model/action-mutations.ts";
import type { HomeEntry } from "../model/home-sections.ts";
import type { SnoozePreset } from "../model/snooze-presets.ts";
import { ActionEditForm } from "./ActionEditForm.tsx";
import { SnoozeMenu } from "./SnoozeMenu.tsx";

type ActionCardProps = {
  entry: HomeEntry;
  sourceTitle: string | null;
  /** The card the keyboard cursor is on (To confirm only). */
  selected?: boolean;
  elementId?: string;
  mode: "active" | "suggested" | "faded";
  editing: boolean;
  snoozeOpen: boolean;
  presets: SnoozePreset[];
  onMutate: (action: ActionItem, mutation: HomeMutation) => void;
  onEditingChange: (editing: boolean) => void;
  onSnoozeOpenChange: (open: boolean) => void;
  onOpenSource: (action: ActionItem) => void;
};

export function ActionCard({
  entry,
  sourceTitle,
  selected = false,
  elementId,
  mode,
  editing,
  snoozeOpen,
  presets,
  onMutate,
  onEditingChange,
  onSnoozeOpenChange,
  onOpenSource,
}: ActionCardProps) {
  const { action } = entry;
  const canOpenSource = Boolean(action.anchor?.noteId);
  const meta = [action.person, entry.dueLabel, entry.waitingLabel].filter(Boolean);

  return (
    <li
      id={elementId}
      className={`home-card${selected ? " is-selected" : ""}${entry.passed ? " is-passed" : ""}`}
      data-home-card=""
      tabIndex={-1}
      aria-current={selected ? "true" : undefined}
    >
      {editing ? (
        <ActionEditForm
          action={action}
          onCancel={() => onEditingChange(false)}
          onSave={(patch: ActionPatch) => {
            onEditingChange(false);
            onMutate(action, { type: "edit", patch });
          }}
        />
      ) : (
        <>
          <p className="home-card-text">{action.text}</p>
          {(meta.length > 0 || entry.reminder || canOpenSource) && (
            <p className="home-card-meta">
              {meta.map((item, index) => (
                <span key={index}>{item}</span>
              ))}
              {entry.reminder && <span>Back from snooze</span>}
              {canOpenSource && sourceTitle && <span className="home-card-source">from {sourceTitle}</span>}
            </p>
          )}
          {entry.recentlyAdded && (
            <p className="home-card-added">
              Added from {sourceTitle ?? "a note"} ·{" "}
              <button
                type="button"
                className="home-link-button"
                aria-label={`Undo adding ${action.text}`}
                onClick={() => onMutate(action, { type: "remove-auto-added" })}
              >
                undo
              </button>
            </p>
          )}
          <div className="home-card-actions" role="group" aria-label={`Actions for ${action.text}`}>
            {mode === "suggested" ? (
              <button type="button" className="home-primary-button" onClick={() => onMutate(action, { type: "accept" })}>
                Accept
              </button>
            ) : mode === "active" ? (
              <button type="button" className="home-primary-button" onClick={() => onMutate(action, { type: "done" })}>
                Done
              </button>
            ) : (
              <button type="button" className="home-quiet-button" onClick={() => onMutate(action, { type: "reopen" })}>
                Bring back
              </button>
            )}
            {mode !== "faded" && (
              <span className="home-snooze-wrap">
                <button
                  type="button"
                  className="home-quiet-button"
                  aria-haspopup="menu"
                  aria-expanded={snoozeOpen}
                  onClick={() => onSnoozeOpenChange(!snoozeOpen)}
                >
                  Snooze
                </button>
                {snoozeOpen && (
                  <SnoozeMenu
                    presets={presets}
                    label={`Snooze ${action.text}`}
                    onClose={() => onSnoozeOpenChange(false)}
                    onPick={(preset) => {
                      onSnoozeOpenChange(false);
                      onMutate(action, { type: "snooze", until: preset.until, label: preset.label });
                    }}
                  />
                )}
              </span>
            )}
            <button type="button" className="home-quiet-button" onClick={() => onEditingChange(true)}>
              Edit
            </button>
            {canOpenSource && (
              <button type="button" className="home-quiet-button" onClick={() => onOpenSource(action)}>
                Open source
              </button>
            )}
            {mode === "suggested" && (
              <button type="button" className="home-quiet-button" onClick={() => onMutate(action, { type: "not-an-action" })}>
                Not an action
              </button>
            )}
            <button
              type="button"
              className="home-quiet-button"
              title="Let go for good. It won't come back."
              onClick={() => onMutate(action, { type: "not-important" })}
            >
              Not important
            </button>
          </div>
        </>
      )}
    </li>
  );
}
