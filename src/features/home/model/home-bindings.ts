import type { ActionAnchor, ActionItem } from "../../../domain/types.ts";

/** What the workspace gives Home. Home owns no tab, draft or navigation logic itself. */
export type HomeWorkspaceBindings = {
  bundleId: string;
  titleForNote: (noteId: string | null | undefined) => string | null;
  /** Turns the text into a draft in this group and starts the normal filing flow. */
  fileCapture: (groupId: string, text: string) => void;
  /** Moves the text into a normal draft tab with the caret at its end. */
  openCaptureAsDraft: (groupId: string, text: string) => void;
  /** Opens the note an action came from, at `anchor` when given (another note, or the evidence of a completion). */
  openSource: (action: ActionItem, anchor?: ActionAnchor) => void;
  /** Set when a system notification was clicked: the card to land on once Home is showing. */
  focusAction: { id: string | null; seq: number } | null;
};
