import { useCallback, useMemo, useRef, useState } from "react";
import type { ActionItem } from "../../../domain/types.ts";
import { useHomeActions } from "../hooks/useHomeActions.ts";
import { useHomeCapture } from "../hooks/useHomeCapture.ts";
import type { HomeMutation } from "../model/action-mutations.ts";
import { isHomeEmpty } from "../model/home-sections.ts";
import { snoozePresets } from "../model/snooze-presets.ts";
import { HomeCapture } from "./HomeCapture.tsx";
import { HomeConfirmList } from "./HomeConfirmList.tsx";
import { HomeSectionList, HomeCardItem, type HomeCardEnv } from "./HomeSectionList.tsx";
import { HomeToasts } from "./HomeToasts.tsx";

export type HomeViewProps = {
  bundleId: string;
  groupId: string;
  /** This group is the one the user is working in. */
  active: boolean;
  focusRequest: number;
  titleForNote: (noteId: string | null | undefined) => string | null;
  onFileCapture: (groupId: string, text: string) => void;
  onOpenAsDraft: (groupId: string, text: string) => void;
  onOpenSource: (action: ActionItem) => void;
  /** Test seams. */
  pollMs?: number;
  now?: () => Date;
  timeZone?: string;
};

/** Where the app starts: write first, then see what needs you. */
export function HomeView({
  bundleId,
  groupId,
  active,
  focusRequest,
  titleForNote,
  onFileCapture,
  onOpenAsDraft,
  onOpenSource,
  pollMs,
  now,
  timeZone,
}: HomeViewProps) {
  const capture = useHomeCapture(bundleId);
  const { sections, loaded, unavailable, toasts, run, refreshSoon, dismissToast, clock, timeZone: zone } = useHomeActions({
    bundleId,
    pollMs,
    now,
    timeZone,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLElement | null>(null);

  /** After a card leaves the screen, keep the keyboard where the user was working. */
  const restoreFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const region = regionRef.current?.isConnected ? regionRef.current : rootRef.current;
      region?.focus({ preventScroll: true });
    });
  }, []);

  const env: HomeCardEnv = useMemo(
    () => ({
      titleForNote,
      presets: snoozePresets(clock, zone),
      editingId,
      snoozeId,
      setEditingId: (id) => {
        setEditingId(id);
        if (!id) restoreFocus();
      },
      setSnoozeId: (id) => {
        setSnoozeId(id);
        if (!id) restoreFocus();
      },
      onMutate: (action: ActionItem, mutation: HomeMutation) => {
        void run(action.id, mutation);
        restoreFocus();
      },
      onOpenSource,
    }),
    [clock, editingId, onOpenSource, restoreFocus, run, snoozeId, titleForNote, zone],
  );

  function handOff(send: (groupId: string, text: string) => void) {
    const text = capture.text;
    if (!text.trim()) return;
    capture.clear();
    send(groupId, text);
  }

  const empty = loaded && isHomeEmpty(sections);
  const fadedCount = sections.faded.length;

  return (
    <div
      ref={rootRef}
      className="home-view"
      data-home-view=""
      tabIndex={-1}
      aria-label="Home"
      onFocusCapture={(event) => {
        regionRef.current = (event.target as HTMLElement).closest<HTMLElement>("[data-home-region]");
      }}
      onFocus={refreshSoon}
    >
      <div className="home-inner">
        <HomeCapture
          text={capture.text}
          active={active}
          focusRequest={focusRequest}
          onChange={capture.change}
          onFile={() => handOff(onFileCapture)}
          onOpenAsDraft={() => handOff(onOpenAsDraft)}
        />

        {empty && (
          <p className="home-empty" role="note">
            Nothing needs you right now.
          </p>
        )}
        {!loaded && unavailable && (
          <p className="home-empty">Your actions will show up here as soon as they're ready.</p>
        )}

        <HomeSectionList id="now" title="Now" entries={sections.now} env={env} />
        {sections.comingUp.length > 0 && (
          <section className="home-section" aria-labelledby="home-coming-up" data-home-region="" tabIndex={-1}>
            <h2 id="home-coming-up" className="home-section-title">
              Coming up
            </h2>
            {sections.comingUp.map((week) => (
              <div key={week.key} className="home-week">
                <h3 className="home-week-title">{week.label}</h3>
                {week.days.map((day) => (
                  <div key={day.key} className="home-day">
                    <h4 className="home-day-title">{day.label}</h4>
                    <ul className="home-card-list">
                      {day.entries.map((entry) => (
                        <HomeCardItem key={entry.action.id} entry={entry} env={env} mode="active" />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
        <HomeSectionList id="waiting" title="Waiting on others" entries={sections.waiting} env={env} />
        <HomeSectionList id="loose-ends" title="Loose ends" entries={sections.looseEnds} env={env} />
        <HomeConfirmList entries={sections.toConfirm} env={env} />

        {fadedCount > 0 && (
          <details className="home-faded">
            <summary>Faded ({fadedCount})</summary>
            <ul className="home-card-list">
              {sections.faded.map((entry) => (
                <HomeCardItem key={entry.action.id} entry={entry} env={env} mode="faded" />
              ))}
            </ul>
          </details>
        )}
        {/* A short summary written by the local model can fill this slot later. */}
        <div data-home-summary-slot="" hidden />
      </div>
      <HomeToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
