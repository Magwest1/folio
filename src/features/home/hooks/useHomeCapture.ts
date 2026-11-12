import { useCallback, useEffect, useRef, useState } from "react";
import { loadHomeCapture, saveHomeCapture } from "../model/capture-storage.ts";

const SAVE_DELAY_MS = 250;

/**
 * The Home writing field's text, kept across reloads until it is filed or moved to a draft.
 * The bundle id can change while the app is starting; text already typed is carried over
 * to the new bundle instead of being lost.
 */
export function useHomeCapture(bundleId: string) {
  const [state, setState] = useState(() => ({ bundleId, text: loadHomeCapture(bundleId) }));
  let current = state;
  if (state.bundleId !== bundleId) {
    current = { bundleId, text: state.text.trim() ? state.text : loadHomeCapture(bundleId) };
    setState(current);
  }
  const { text } = current;
  const textRef = useRef(text);
  const timerRef = useRef<number | null>(null);
  const previousBundleRef = useRef(bundleId);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    saveHomeCapture(bundleId, textRef.current);
  }, [bundleId]);

  useEffect(() => {
    const previous = previousBundleRef.current;
    if (previous === bundleId) return;
    previousBundleRef.current = bundleId;
    if (!textRef.current.trim()) return;
    saveHomeCapture(previous, "");
    saveHomeCapture(bundleId, textRef.current);
  }, [bundleId]);

  const change = useCallback((next: string) => {
    textRef.current = next;
    setState((existing) => ({ ...existing, text: next }));
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, SAVE_DELAY_MS);
  }, [flush]);

  /** Empties the field and forgets the stored copy right away. */
  const clear = useCallback(() => {
    textRef.current = "";
    setState((existing) => ({ ...existing, text: "" }));
    flush();
  }, [flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return { text, change, clear };
}
