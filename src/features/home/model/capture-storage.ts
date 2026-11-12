import { readStorageItem, removeStorageItem, writeStorageItem } from "../../../lib/storage.ts";

/** Namespaced, per-bundle key for the unfinished Home capture. */
export const HOME_CAPTURE_STORAGE_KEY = "folio:home-capture:v1";

const keyFor = (bundleId: string) => `${HOME_CAPTURE_STORAGE_KEY}:${bundleId}`;

export function loadHomeCapture(bundleId: string): string {
  try {
    const stored = readStorageItem(keyFor(bundleId));
    if (!stored) return "";
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string"
      ? (parsed as { text: string }).text
      : "";
  } catch {
    return "";
  }
}

export function saveHomeCapture(bundleId: string, text: string): void {
  try {
    if (text.trim()) writeStorageItem(keyFor(bundleId), JSON.stringify({ text }));
    else removeStorageItem(keyFor(bundleId));
  } catch {
    /* optional persistence */
  }
}
