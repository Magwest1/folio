/** Asks the open note editor to select and scroll to a quoted passage. */
export const REVEAL_PASSAGE_EVENT = "folio-reveal-passage";

export type PassageRevealDetail = { from: number; to: number; quote: string };

const MAX_WAIT_FRAMES = 180;

/**
 * Waits for the editor of `noteId` to mount, then dispatches the reveal event.
 * Gives up quietly: the note is already open, which is the safe fallback.
 */
export function revealPassageWhenReady(noteId: string, detail: PassageRevealDetail): () => void {
  let frame = 0;
  let waited = 0;
  const attempt = () => {
    const hosts = document.querySelectorAll<HTMLElement>("[data-live-markdown-editor][data-document-id]");
    const host = Array.from(hosts).find((candidate) => candidate.dataset.documentId === noteId);
    if (host) {
      host.dispatchEvent(new CustomEvent<PassageRevealDetail>(REVEAL_PASSAGE_EVENT, { detail }));
      return;
    }
    if ((waited += 1) < MAX_WAIT_FRAMES) frame = window.requestAnimationFrame(attempt);
  };
  frame = window.requestAnimationFrame(attempt);
  return () => window.cancelAnimationFrame(frame);
}
