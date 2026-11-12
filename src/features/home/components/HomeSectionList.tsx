import type { ReactNode } from "react";
import type { ActionItem } from "../../../domain/types.ts";
import type { HomeMutation } from "../model/action-mutations.ts";
import type { HomeEntry } from "../model/home-sections.ts";
import type { SnoozePreset } from "../model/snooze-presets.ts";
import { ActionCard } from "./ActionCard.tsx";

/** Everything a card needs from Home, so sections stay thin. */
export type HomeCardEnv = {
  titleForNote: (noteId: string | null | undefined) => string | null;
  presets: SnoozePreset[];
  editingId: string | null;
  snoozeId: string | null;
  setEditingId: (id: string | null) => void;
  setSnoozeId: (id: string | null) => void;
  onMutate: (action: ActionItem, mutation: HomeMutation) => void;
  onOpenSource: (action: ActionItem) => void;
};

export function HomeCardItem({
  entry,
  env,
  mode,
  selected,
  elementId,
}: {
  entry: HomeEntry;
  env: HomeCardEnv;
  mode: "active" | "suggested" | "faded";
  selected?: boolean;
  elementId?: string;
}) {
  const { action } = entry;
  return (
    <ActionCard
      entry={entry}
      mode={mode}
      selected={selected}
      elementId={elementId}
      sourceTitle={env.titleForNote(action.anchor?.noteId)}
      presets={env.presets}
      editing={env.editingId === action.id}
      snoozeOpen={env.snoozeId === action.id}
      onEditingChange={(editing) => env.setEditingId(editing ? action.id : null)}
      onSnoozeOpenChange={(open) => env.setSnoozeId(open ? action.id : null)}
      onMutate={env.onMutate}
      onOpenSource={env.onOpenSource}
    />
  );
}

type HomeSectionListProps = {
  id: string;
  title: string;
  count?: number;
  entries: HomeEntry[];
  env: HomeCardEnv;
  mode?: "active" | "suggested" | "faded";
  children?: ReactNode;
};

export function HomeSectionList({ id, title, entries, env, mode = "active", children }: HomeSectionListProps) {
  if (!entries.length) return null;
  return (
    <section className="home-section" aria-labelledby={`home-${id}`} data-home-region="" tabIndex={-1}>
      <h2 id={`home-${id}`} className="home-section-title">
        {title}
      </h2>
      {children}
      <ul className="home-card-list">
        {entries.map((entry) => (
          <HomeCardItem key={entry.action.id} entry={entry} env={env} mode={mode} />
        ))}
      </ul>
    </section>
  );
}
