import { useId, useState } from "react";
import type { ActionKind, ReminderLevel } from "../../../domain/types.ts";
import { useReminderSettings } from "../hooks/useReminderSettings.ts";

const LEVELS: ReadonlyArray<readonly [ReminderLevel, string, string]> = [
  ["off", "Off", "Nothing interrupts you."],
  ["gentle", "Gentle", "Silent, once a day for what's due, plus snoozes."],
  ["normal", "Normal", "Also nudges at the time you set for something."],
];

const KINDS: ReadonlyArray<readonly [ActionKind, string]> = [
  ["waiting-on", "Waiting on others"],
  ["follow-up", "Follow-ups"],
  ["event", "Events"],
  ["my-commitment", "My commitments"],
  ["task", "Tasks"],
];

function sourceLabel(source: string) {
  return source.endsWith("/") ? `${source} (folder)` : source;
}

export function ReminderSettings() {
  const id = useId();
  const { settings, suppressions, loadError, error, saved, save, setKindMuted, includeSource } = useReminderSettings();
  const [days, setDays] = useState<{ from: number; text: string } | null>(null);
  const native = typeof window !== "undefined" && Boolean(window.folio?.reminders);

  if (!settings) {
    return (
      <section className="settings-section" aria-labelledby={`${id}-title`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-title`}>Reminders</h2>
          <p>{loadError || "Loading…"}</p>
        </div>
      </section>
    );
  }

  const quiet = settings.quietHours;
  const brief = settings.morningBrief;
  const daysText = days && days.from === settings.stillRelevantAfterDays ? days.text : String(settings.stillRelevantAfterDays);
  const commitDays = () => {
    const value = Number(daysText);
    if (Number.isInteger(value) && value >= 1 && value <= 365 && value !== settings.stillRelevantAfterDays)
      void save({ stillRelevantAfterDays: value });
    setDays(null);
  };

  return (
    <div className="reminder-settings">
      <section className="settings-section" aria-labelledby={`${id}-title`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-title`}>Reminders</h2>
          <p>
            Only things with a date, or that you snoozed, ever notify you. Anything can be let go for good with one click.
            {native ? " Reminders arrive as notifications." : " In the browser they appear on Home."}
          </p>
        </div>
        <div className="reminder-segments" role="radiogroup" aria-label="Reminder level">
          {LEVELS.map(([value, label, hint]) => (
            <label key={value} className={`reminder-segment${settings.level === value ? " is-selected" : ""}`}>
              <input
                type="radio"
                name={`${id}-level`}
                value={value}
                checked={settings.level === value}
                onChange={() => void save({ level: value })}
              />
              <strong>{label}</strong>
              <small>{hint}</small>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-quiet`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-quiet`}>Quiet hours</h2>
          <p>Reminders that land in this window wait until it ends.</p>
        </div>
        <label className="reminder-toggle">
          <input type="checkbox" checked={quiet.enabled} onChange={(event) => void save({ quietHours: { enabled: event.target.checked } })} />
          <span>Keep quiet hours</span>
        </label>
        <div className="reminder-times">
          <label>
            <span>From</span>
            <input type="time" aria-label="Quiet hours start" value={quiet.start} disabled={!quiet.enabled} onChange={(event) => event.target.value && void save({ quietHours: { start: event.target.value } })} />
          </label>
          <label>
            <span>Until</span>
            <input type="time" aria-label="Quiet hours end" value={quiet.end} disabled={!quiet.enabled} onChange={(event) => event.target.value && void save({ quietHours: { end: event.target.value } })} />
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-brief`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-brief`}>Morning brief</h2>
          <p>One short note about today, instead of separate reminders for the day's items. Skipped on empty days.</p>
        </div>
        <label className="reminder-toggle">
          <input type="checkbox" checked={brief.enabled} onChange={(event) => void save({ morningBrief: { enabled: event.target.checked } })} />
          <span>Send a morning brief</span>
        </label>
        <div className="reminder-times">
          <label>
            <span>At</span>
            <input type="time" aria-label="Morning brief time" value={brief.time} disabled={!brief.enabled} onChange={(event) => event.target.value && void save({ morningBrief: { time: event.target.value } })} />
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-relevant`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-relevant`}>Still relevant?</h2>
          <p>
            When something you never wrote down yourself goes quiet, Home asks once. If you don't answer, it fades
            to the Faded tray a week later. No notification, no nagging.
          </p>
        </div>
        <label className="reminder-days">
          <span>Ask after</span>
          <input
            type="number"
            min={1}
            max={365}
            value={daysText}
            onChange={(event) => setDays({ from: settings.stillRelevantAfterDays, text: event.target.value })}
            onBlur={commitDays}
            onKeyDown={(event) => event.key === "Enter" && commitDays()}
            aria-label="Ask whether it's still relevant after this many days"
          />
          <span>days</span>
        </label>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-mute`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-mute`}>Stay quiet about</h2>
          <p>Checked kinds never remind you, and are left out of new suggestions.</p>
        </div>
        <div className="reminder-kinds" role="group" aria-labelledby={`${id}-mute`}>
          {KINDS.map(([kind, label]) => (
            <label key={kind} className="reminder-toggle">
              <input type="checkbox" checked={suppressions.kinds.includes(kind)} onChange={(event) => void setKindMuted(kind, event.target.checked)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${id}-sources`}>
        <div className="settings-section-copy">
          <h2 id={`${id}-sources`}>Left out</h2>
          <p>Notes and folders you've asked Folio to ignore for actions.</p>
        </div>
        {suppressions.sources.length === 0 ? (
          <p className="settings-import-message">Nothing is left out.</p>
        ) : (
          <ul className="reminder-sources">
            {suppressions.sources.map((source) => (
              <li key={source}>
                <span title={source}>{sourceLabel(source)}</span>
                <button type="button" className="settings-action" aria-label={`Include ${source} again`} onClick={() => void includeSource(source)}>
                  Include again
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="reminder-status" role="status" aria-live="polite">
        {error || (saved ? "Saved." : "")}
      </p>
    </div>
  );
}
