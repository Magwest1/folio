import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ActionItem, BundleFile, Note, TabGroup, ViewerDocument } from "../../../domain/types.ts";
import { revealPassageWhenReady } from "../../../lib/passage-reveal.ts";
import { serializeDraft } from "../../../lib/workspace.ts";
import type { HomeWorkspaceBindings } from "../model/home-bindings.ts";
import { HOME_TAB_ID, openHomeTab } from "../model/home-tab.ts";

type Options = {
  bundleId: string;
  notes: Note[];
  files: BundleFile[];
  documents: Record<string, ViewerDocument>;
  groups: TabGroup[];
  activeGroupId: string;
  setGroups: Dispatch<SetStateAction<TabGroup[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string>>;
  createDraft: (groupId: string, content: string) => string;
  fileDraft: (document: ViewerDocument) => void;
  rememberSelection: (documentId: string, from: number, to: number) => void;
  openNote: (id: string, groupId: string) => Promise<void>;
  requestFocus: (groupId: string, documentId: string) => void;
};

/**
 * Connects Home to the workspace. Filing reuses the draft pipeline end to end:
 * the capture becomes a draft tab and filing starts on it, so the user sees the
 * same classification and confirmation as for any other draft.
 */
export function useHomeWorkspace({
  bundleId,
  notes,
  files,
  documents,
  groups,
  activeGroupId,
  setGroups,
  setActiveGroupId,
  createDraft,
  fileDraft,
  rememberSelection,
  openNote,
  requestFocus,
}: Options) {
  const pendingFilingId = useRef<string | null>(null);

  // The draft exists in state only after the render that created it.
  useEffect(() => {
    const id = pendingFilingId.current;
    const draft = id ? documents[id] : undefined;
    if (!draft) return;
    pendingFilingId.current = null;
    fileDraft(draft);
  }, [documents, fileDraft]);

  const [focusAction, setFocusAction] = useState<HomeWorkspaceBindings["focusAction"]>(null);

  const openHome = useCallback(
    (groupId = activeGroupId) => {
      const opened = openHomeTab(groups, groupId);
      setGroups(opened.groups);
      setActiveGroupId(opened.groupId);
      requestFocus(opened.groupId, HOME_TAB_ID);
    },
    [activeGroupId, groups, requestFocus, setActiveGroupId, setGroups],
  );

  // A clicked system notification brings Home forward and names the card to land on.
  const openHomeRef = useRef(openHome);
  useEffect(() => {
    openHomeRef.current = openHome;
  });
  useEffect(() => {
    return window.folio?.reminders?.onFocusAction((actionId) => {
      openHomeRef.current();
      setFocusAction((current) => ({ id: actionId, seq: (current?.seq ?? 0) + 1 }));
    });
  }, []);

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of files) map.set(file.id, file.title);
    for (const note of notes) map.set(note.id, note.title);
    return map;
  }, [files, notes]);

  const bindings: HomeWorkspaceBindings = useMemo(
    () => ({
      bundleId,
      titleForNote: (noteId) => (noteId ? (titles.get(noteId) ?? null) : null),
      fileCapture: (groupId, text) => {
        pendingFilingId.current = createDraft(groupId, serializeDraft("", text));
      },
      openCaptureAsDraft: (groupId, text) => {
        const content = serializeDraft("", text);
        const id = createDraft(groupId, content);
        rememberSelection(id, content.length, content.length);
      },
      openSource: (action: ActionItem) => {
        const anchor = action.anchor;
        if (!anchor?.noteId) return;
        const noteId = anchor.noteId;
        void openNote(noteId, activeGroupId).then(() => {
          // An orphaned anchor no longer points at its passage, so only open the note.
          if (!anchor.orphaned && anchor.quote)
            revealPassageWhenReady(noteId, { from: anchor.from, to: anchor.to, quote: anchor.quote });
        });
      },
      focusAction,
    }),
    [activeGroupId, bundleId, createDraft, focusAction, openNote, rememberSelection, titles],
  );

  return { bindings, openHome };
}
