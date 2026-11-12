import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionKind, ActionSuppressions, ReminderSettings } from "../../../domain/types.ts";
import {
  fetchActionSuppressions,
  fetchReminderSettings,
  saveReminderSettings,
  setActionSuppression,
} from "../../../lib/api.ts";

export type ReminderSettingsPatch = {
  level?: ReminderSettings["level"];
  quietHours?: Partial<ReminderSettings["quietHours"]>;
  morningBrief?: Partial<ReminderSettings["morningBrief"]>;
  stillRelevantAfterDays?: number;
};

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** Loads the bundle's reminder settings and mutes, and saves each change as soon as it is made. */
export function useReminderSettings() {
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [suppressions, setSuppressions] = useState<ActionSuppressions>({ sources: [], kinds: [] });
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void Promise.all([fetchReminderSettings(), fetchActionSuppressions()])
      .then(([nextSettings, nextSuppressions]) => {
        if (!current) return;
        setSettings(nextSettings);
        setSuppressions(nextSuppressions);
      })
      .catch((cause) => current && setLoadError(message(cause, "Reminders aren't available right now.")));
    return () => {
      current = false;
      window.clearTimeout(savedTimer.current);
    };
  }, []);

  const flashSaved = useCallback(() => {
    setSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 2_500);
  }, []);

  const save = useCallback(
    async (patch: ReminderSettingsPatch) => {
      setError("");
      try {
        setSettings(await saveReminderSettings(patch));
        flashSaved();
      } catch (cause) {
        setError(message(cause, "That didn't save. Your settings are unchanged."));
      }
    },
    [flashSaved],
  );

  const setKindMuted = useCallback(
    async (kind: ActionKind, muted: boolean) => {
      setError("");
      try {
        setSuppressions(await setActionSuppression({ kind }, muted));
        flashSaved();
      } catch (cause) {
        setError(message(cause, "That didn't save. Your settings are unchanged."));
      }
    },
    [flashSaved],
  );

  const includeSource = useCallback(
    async (source: string) => {
      setError("");
      try {
        setSuppressions(await setActionSuppression({ source }, false));
        flashSaved();
      } catch (cause) {
        setError(message(cause, "That didn't save. Your settings are unchanged."));
      }
    },
    [flashSaved],
  );

  return { settings, suppressions, loadError, error, saved, save, setKindMuted, includeSource };
}
