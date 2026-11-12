import type {
  ActionItem,
  ActionKind,
  ActionSuppressions,
  ActionPatch,
  ActionStatus,
  ActionTransition,
  NoteLanguageInfo,
  NoteTranslation,
  PendingReminders,
  ReminderSettings,
  NoteTranslationTarget,
  TranslatedExportJob,
  TranslatedExportTarget,
  TranslationSettings,
} from "../domain/types.ts";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let activeBundleId: string | null = null;

export function setActiveBundleId(bundleId: string | null) {
  activeBundleId = bundleId;
}

export function getActiveBundleId() {
  return activeBundleId;
}

export async function apiForBundle<T>(bundleId: string | null, url: string, options?: RequestInit): Promise<T> {
  return api<T>(url, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...(bundleId ? { "x-folio-bundle": bundleId, "x-folio-bundle-id": bundleId } : {}),
    },
  });
}

/** Keeps the server's response and error semantics in one place for every feature. */
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(activeBundleId ? { "x-folio-bundle": activeBundleId } : {}),
        ...(activeBundleId ? { "x-folio-bundle-id": activeBundleId } : {}),
        ...options?.headers,
      },
    });
  } catch {
    throw new Error("The local FolioNotes service is not ready yet.");
  }
  const body = await response.text();
  let result: unknown = null;
  if (body) {
    try {
      result = JSON.parse(body);
    } catch {
      throw new Error(
        response.ok
          ? "The server returned an invalid response."
          : [502, 503, 504].includes(response.status)
            ? "The local FolioNotes service is not ready yet."
            : `Request failed (${response.status}).`,
      );
    }
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : [502, 503, 504].includes(response.status)
          ? "The local FolioNotes service is not ready yet."
          : `Request failed (${response.status}).`;
    throw new ApiError(error, response.status);
  }
  return result as T;
}

export async function apiWithRetry<T>(
  url: string,
  options?: RequestInit,
  attempts = 8,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api<T>(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1)
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(250 * 2 ** attempt, 1500)),
        );
    }
  }
  throw lastError;
}

export function fetchNoteTranslation(
  id: string,
  target: NoteTranslationTarget,
  signal?: AbortSignal,
): Promise<NoteTranslation> {
  return api<NoteTranslation>(
    `/api/note/translation?id=${encodeURIComponent(id)}&target=${target}`,
    { signal },
  );
}

export function prioritizeNoteTranslation(id: string): Promise<{ queued: boolean }> {
  return api<{ queued: boolean }>("/api/note/translation/prioritize", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function fetchTranslationSettings(): Promise<TranslationSettings> {
  return api<TranslationSettings>("/api/translation/settings");
}

export function setNoteAutoTranslate(
  id: string,
  enabled: boolean,
): Promise<{ id: string; autoTranslate: boolean; available: boolean }> {
  return api<{ id: string; autoTranslate: boolean; available: boolean }>("/api/note/translation/auto", {
    method: "PUT",
    body: JSON.stringify({ id, enabled }),
  });
}

export function startTranslatedExport(
  id: string,
  target: TranslatedExportTarget,
  markdown?: string,
): Promise<TranslatedExportJob> {
  return api<TranslatedExportJob>("/api/note/translation/export", {
    method: "POST",
    body: JSON.stringify(markdown === undefined ? { id, target } : { id, target, markdown }),
  });
}

export function fetchTranslatedExport(jobId: string, signal?: AbortSignal): Promise<TranslatedExportJob> {
  return api<TranslatedExportJob>(`/api/note/translation/export/${encodeURIComponent(jobId)}`, { signal });
}

export function cancelTranslatedExport(jobId: string): Promise<{ jobId: string; status: "cancelled" }> {
  return api<{ jobId: string; status: "cancelled" }>(`/api/note/translation/export/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export function fetchNoteLanguage(id: string, signal?: AbortSignal): Promise<NoteLanguageInfo> {
  return api<NoteLanguageInfo>(`/api/note/language?id=${encodeURIComponent(id)}`, { signal });
}

export function fetchActions(
  options: { status?: ActionStatus[]; includeClosed?: boolean } = {},
  signal?: AbortSignal,
): Promise<ActionItem[]> {
  const params = new URLSearchParams();
  if (options.status?.length) params.set("status", options.status.join(","));
  if (options.includeClosed) params.set("includeClosed", "true");
  const query = params.toString();
  return api<ActionItem[]>(`/api/actions${query ? `?${query}` : ""}`, { signal });
}

export function transitionAction(
  id: string,
  transition: ActionTransition,
  body: { until?: string } = {},
): Promise<ActionItem> {
  return api<ActionItem>(`/api/actions/${encodeURIComponent(id)}/${transition}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchAction(id: string, patch: ActionPatch): Promise<ActionItem> {
  return api<ActionItem>(`/api/actions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Snoozes in plain words ("tomorrow after lunch"). The server answers with the resolved time. */
export function snoozeActionWithPhrase(
  id: string,
  phrase: string,
  timeZone: string,
): Promise<ActionItem & { until: string }> {
  return api<ActionItem & { until: string }>(`/api/actions/${encodeURIComponent(id)}/snooze`, {
    method: "POST",
    body: JSON.stringify({ phrase, timeZone }),
  });
}

export function clearNoteActions(noteId: string): Promise<{ ids: string[] }> {
  return api<{ ids: string[] }>("/api/actions/clear-note", { method: "POST", body: JSON.stringify({ noteId }) });
}

export function undoActionBatch(ids: string[]): Promise<{ ids: string[] }> {
  return api<{ ids: string[] }>("/api/actions/undo-batch", { method: "POST", body: JSON.stringify({ ids }) });
}

export function fetchReminderSettings(signal?: AbortSignal): Promise<ReminderSettings> {
  return api<ReminderSettings>("/api/reminders/settings", { signal });
}

export function saveReminderSettings(patch: Partial<ReminderSettings> | Record<string, unknown>): Promise<ReminderSettings> {
  return api<ReminderSettings>("/api/reminders/settings", { method: "PUT", body: JSON.stringify(patch) });
}

export function fetchPendingReminders(signal?: AbortSignal): Promise<PendingReminders> {
  return api<PendingReminders>("/api/reminders/pending", { signal });
}

export function ackReminder(id: string): Promise<{ acked: boolean }> {
  return api<{ acked: boolean }>(`/api/reminders/${encodeURIComponent(id)}/ack`, { method: "POST" });
}

export function fetchActionSuppressions(signal?: AbortSignal): Promise<ActionSuppressions> {
  return api<ActionSuppressions>("/api/actions/suppressions", { signal });
}

export function setActionSuppression(
  target: { kind: ActionKind } | { source: string },
  muted: boolean,
): Promise<ActionSuppressions> {
  if (muted)
    return api<ActionSuppressions>("/api/actions/suppressions", { method: "POST", body: JSON.stringify(target) });
  const [key, value] = Object.entries(target)[0];
  return api<ActionSuppressions>(`/api/actions/suppressions?${key}=${encodeURIComponent(value)}`, { method: "DELETE" });
}
