import type { ActionItem } from "../../../domain/types.ts";

/** What the workspace gives Home. Home owns no tab, draft or navigation logic itself. */
export type HomeWorkspaceBindings = {
  bundleId: string;
  titleForNote: (noteId: string | null | undefined) => string | null;
  /** Turns the text into a draft in this group and starts the normal filing flow. */
  fileCapture: (groupId: string, text: string) => void;
  /** Moves the text into a normal draft tab with the caret at its end. */
  openCaptureAsDraft: (groupId: string, text: string) => void;
  openSource: (action: ActionItem) => void;
  /** Set when a system notification was clicked: the card to land on once Home is showing. */
  focusAction: { id: string | null; seq: number } | null;
};
