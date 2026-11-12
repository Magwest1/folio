import { act, render, renderHook, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionItem, TabGroup, ViewerDocument } from "../../src/domain/types.ts";
import { LiveMarkdownEditor } from "../../src/features/workspace/components/LiveMarkdownEditor.tsx";
import { useHomeWorkspace } from "../../src/features/home/hooks/useHomeWorkspace.ts";
import { HOME_TAB_ID } from "../../src/features/home/model/home-tab.ts";
import { revealPassageWhenReady } from "../../src/lib/passage-reveal.ts";

afterEach(() => vi.restoreAllMocks());

function draftDocument(id: string, content: string): ViewerDocument {
  return {
    id, title: "Untitled", type: "Local draft", description: "", tags: [], createdAt: "2026-11-12T10:00:00Z", content,
    deletable: true, movable: false, status: "draft", staleAfter: null, stale: false, filedBy: null, filedAt: null,
    links: [], backlinks: [], suggestions: [], updatedAt: "2026-11-12T10:00:00Z",
  };
}

function setup() {
  const fileDraft = vi.fn();
  const rememberSelection = vi.fn();
  const openNote = vi.fn().mockResolvedValue(undefined);
  const requestFocus = vi.fn();
  let counter = 0;
  const hook = renderHook(() => {
    const [documents, setDocuments] = useState<Record<string, ViewerDocument>>({});
    const [groups, setGroups] = useState<TabGroup[]>([{ id: "primary", tabs: [HOME_TAB_ID], activeId: HOME_TAB_ID, previewId: null }]);
    const [activeGroupId, setActiveGroupId] = useState("primary");
    const home = useHomeWorkspace({
      bundleId: "bundle-a",
      notes: [],
      files: [],
      documents,
      groups,
      activeGroupId,
      setGroups,
      setActiveGroupId,
      createDraft: (groupId, content) => {
        const id = `untitled:${(counter += 1)}`;
        setDocuments((current) => ({ ...current, [id]: draftDocument(id, content) }));
        setGroups((current) => current.map((group) => (group.id === groupId ? { ...group, tabs: [...group.tabs, id], activeId: id } : group)));
        return id;
      },
      fileDraft,
      rememberSelection,
      openNote,
      requestFocus,
    });
    return { ...home, groups };
  });
  return { ...hook, fileDraft, rememberSelection, openNote, requestFocus };
}

describe("Home hand-off to the workspace", () => {
  it("files a capture through the normal draft pipeline", () => {
    const { result, fileDraft } = setup();
    act(() => result.current.bindings.fileCapture("primary", "Met Kari\nabout the roof"));
    // A real draft tab exists, active in the same group, and filing started on it exactly once.
    expect(result.current.groups[0].activeId).toBe("untitled:1");
    expect(fileDraft).toHaveBeenCalledTimes(1);
    expect(fileDraft.mock.calls[0][0]).toMatchObject({ id: "untitled:1", content: "\nMet Kari\nabout the roof" });
  });

  it("opens a capture as a draft with the caret at the end and nothing filed", () => {
    const { result, fileDraft, rememberSelection } = setup();
    act(() => result.current.bindings.openCaptureAsDraft("primary", "one\ntwo"));
    expect(result.current.groups[0].activeId).toBe("untitled:1");
    expect(fileDraft).not.toHaveBeenCalled();
    // Offsets include the empty filing-guidance line.
    expect(rememberSelection).toHaveBeenCalledWith("untitled:1", 8, 8);
  });

  it("reopens Home where it already lives and asks for focus", () => {
    const { result, requestFocus } = setup();
    act(() => result.current.openHome());
    expect(requestFocus).toHaveBeenCalledWith("primary", HOME_TAB_ID);
  });

  it("opens the source note and reveals the passage, except for orphaned anchors", async () => {
    const { result, openNote } = setup();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const action = (orphaned: boolean) => ({
      id: "a", anchor: { noteId: "/notes/a.md", from: 6, to: 10, quote: "roof", orphaned },
    }) as ActionItem;

    await act(async () => result.current.bindings.openSource(action(true)));
    expect(openNote).toHaveBeenCalledWith("/notes/a.md", "primary");
    expect(frames).toHaveLength(0);

    await act(async () => result.current.bindings.openSource(action(false)));
    expect(frames).toHaveLength(1);
  });
});

describe("passage reveal", () => {
  function mountEditor(value: string, documentId = "/notes/a.md") {
    render(<LiveMarkdownEditor value={value} onChange={vi.fn()} documentId={documentId} ariaLabel="Edit a" />);
    return EditorView.findFromDOM(screen.getByLabelText("Edit a"))!;
  }

  it("selects the anchored passage in the matching editor", () => {
    const view = mountEditor("Roof is leaking. Call Kari about the roof today.");
    const quote = "Call Kari about the roof";
    revealAfterFrame("/notes/a.md", { from: 17, to: 17 + quote.length, quote });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(quote);
  });

  it("finds the quote again when the offsets have drifted", () => {
    const view = mountEditor("A new first line.\nRoof is leaking. Call Kari about the roof today.");
    const quote = "Call Kari about the roof";
    revealAfterFrame("/notes/a.md", { from: 17, to: 17 + quote.length, quote });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(quote);
  });

  it("leaves other notes alone", () => {
    const view = mountEditor("Some text here", "/notes/other.md");
    revealAfterFrame("/notes/a.md", { from: 0, to: 4, quote: "Some" });
    expect(view.state.selection.main.empty).toBe(true);
  });
});

function revealAfterFrame(noteId: string, detail: { from: number; to: number; quote: string }) {
  const frames: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  revealPassageWhenReady(noteId, detail);
  act(() => frames.shift()?.(0));
  spy.mockRestore();
}
