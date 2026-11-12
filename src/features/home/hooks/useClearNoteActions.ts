import { useCallback, useEffect, useRef, useState } from "react";
import { clearNoteActions, undoActionBatch } from "../../../lib/api.ts";

const MESSAGE_MS = 10_000;

export type ClearNoteNotice = { message: string; undo?: () => void };

/**
 * "Clear actions from this note" for places outside Home, such as a note's More menu. One request lets go of
 * everything open from the note; the notice offers a single Undo that brings the same items back.
 */
export function useClearNoteActions() {
  const [notice, setNotice] = useState<ClearNoteNotice | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const dismiss = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setNotice(null);
  }, []);

  const show = useCallback((next: ClearNoteNotice) => {
    window.clearTimeout(timerRef.current);
    setNotice(next);
    timerRef.current = window.setTimeout(() => setNotice(null), MESSAGE_MS);
  }, []);

  const clear = useCallback(
    async (noteId: string) => {
      try {
        const { ids } = await clearNoteActions(noteId);
        if (ids.length === 0) {
          show({ message: "Nothing open from this note." });
          return;
        }
        show({
          message: `Let go of ${ids.length === 1 ? "1 item" : `${ids.length} items`} from this note. They won't come back.`,
          undo: () => {
            setNotice(null);
            void undoActionBatch(ids)
              .then(() => show({ message: "Brought back." }))
              .catch(() => show({ message: "That didn't go through." }));
          },
        });
      } catch {
        show({ message: "That didn't go through. Nothing was changed." });
      }
    },
    [show],
  );

  return { notice, clear, dismiss };
}
