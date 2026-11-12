import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabGroup, ViewerDocument } from "../../src/domain/types.ts";
import { EditorWorkspace } from "../../src/features/workspace/components/EditorWorkspace.tsx";
import { useWorkspaceShortcutActions } from "../../src/features/workspace/hooks/useWorkspaceShortcutActions.ts";
import { useWorkspaceTabs } from "../../src/features/workspace/hooks/useWorkspaceTabs.ts";
import { reconcileWorkspaceSessionState } from "../../src/features/workspace/model/workspace-state.ts";
import type { EditorWorkspaceProps } from "../../src/features/workspace/types.ts";
import type { HomeWorkspaceBindings } from "../../src/features/home/model/home-bindings.ts";
import { HOME_TAB_ID } from "../../src/features/home/model/home-tab.ts";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

const group = (id: "primary" | "secondary", tabs: string[], activeId: string | null): TabGroup => ({ id, tabs, activeId, previewId: null });

function homeBindings(): HomeWorkspaceBindings {
  return {
    bundleId: "bundle-a",
    titleForNote: () => null,
    fileCapture: vi.fn(),
    openCaptureAsDraft: vi.fn(),
    openSource: vi.fn(),
  };
}

function workspace(groups: TabGroup[], home = homeBindings(), openHome = vi.fn()) {
  const props = {
    home,
    model: {
      groups, splitPosition: 50, activeGroupId: "primary", documents: {}, loadingDocuments: new Set(), savingDocuments: new Set(),
      editingKey: null, drafts: {}, deletingNoteId: null, movingFileId: null, filingDirectories: [], filingQueues: {}, refileEntries: {},
      editorFocusRequest: null, message: "", exportingNoteId: null,
    },
    actions: {
      titleForId: (id: string) => (id === HOME_TAB_ID ? "Home" : id),
      activateGroup: vi.fn(), activateTab: vi.fn(), closeTab: vi.fn(), createNewTab: vi.fn(), openHome,
      splitWorkspace: vi.fn(), closeGroup: vi.fn(), pinTab: vi.fn(), moveTabToGroup: vi.fn(), consumeEditorFocusRequest: vi.fn(),
    },
  } as unknown as EditorWorkspaceProps;
  return { ...render(<EditorWorkspace {...props} />), home, openHome };
}

describe("Home in the workspace", () => {
  it("lets the user type immediately when the app starts with nothing open", () => {
    workspace([group("primary", [], null)]);
    expect(screen.getByRole("textbox", { name: "Capture" })).toHaveFocus();
  });

  it("shows Home in an empty group instead of a blank pane", () => {
    workspace([group("primary", [], null)]);
    expect(screen.getByRole("textbox", { name: "Capture" })).toBeInTheDocument();
    expect(screen.queryByText("Open a note.")).not.toBeInTheDocument();
  });

  it("does not show two writing fields when Home is already open in the other group", () => {
    workspace([group("primary", [HOME_TAB_ID], HOME_TAB_ID), group("secondary", [], null)]);
    expect(screen.getAllByRole("textbox", { name: "Capture" })).toHaveLength(1);
    expect(screen.getByText("Open a note.")).toBeInTheDocument();
  });

  it("offers Home from the tab strip and as a closable tab", () => {
    const { openHome } = workspace([group("primary", [HOME_TAB_ID, "/a.md"], "/a.md")]);
    fireEvent.click(screen.getAllByRole("button", { name: "Home" })[0]);
    expect(openHome).toHaveBeenCalledWith("primary");
    expect(screen.getByRole("button", { name: "Close Home" })).toBeInTheDocument();
  });
});

describe("Home and the tab model", () => {
  const options = (overrides: Partial<Parameters<typeof useWorkspaceTabs>[0]> = {}) => ({
    documents: {} as Record<string, ViewerDocument>,
    drafts: {} as Record<string, string>,
    notes: [],
    files: [],
    setDocuments: vi.fn(),
    setDrafts: vi.fn(),
    setEditingKey: vi.fn(),
    draftTitle: () => "Untitled",
    ...overrides,
  });

  it("leaves a fresh workspace with an empty group, which shows Home", () => {
    const { result } = renderHook(() => useWorkspaceTabs(options()));
    expect(result.current.groups).toEqual([group("primary", [], null)]);
    expect(result.current.titleForId(HOME_TAB_ID)).toBe("Home");
  });

  const session = (groups: TabGroup[]) => ({
    version: 1 as const, groups, activeGroupId: "primary", sidebarMode: "explore" as const, explorerScrollTop: 0, documentScrollTops: {},
  });

  it("restores into an unfinished draft instead of Home", () => {
    const { result } = renderHook(() =>
      useWorkspaceTabs(options({
        drafts: { "untitled:1": "\nwhere I stopped" },
        initialState: session([group("primary", [HOME_TAB_ID, "untitled:1"], HOME_TAB_ID)]),
      })),
    );
    expect(result.current.groups[0].activeId).toBe("untitled:1");
  });

  it("keeps a restored note active and keeps Home through reconciliation", () => {
    const { result } = renderHook(() =>
      useWorkspaceTabs(options({
        drafts: { "untitled:1": "\nwhere I stopped" },
        initialState: session([group("primary", [HOME_TAB_ID, "/a.md", "untitled:1"], "/a.md")]),
      })),
    );
    expect(result.current.groups[0].activeId).toBe("/a.md");
    const reconciled = reconcileWorkspaceSessionState(session([group("primary", [HOME_TAB_ID, "/gone.md"], HOME_TAB_ID)]), new Set());
    expect(reconciled.groups[0]).toMatchObject({ tabs: [HOME_TAB_ID], activeId: HOME_TAB_ID });
  });

  it("keeps a restored empty workspace empty so Home shows as its empty state", () => {
    const { result } = renderHook(() => useWorkspaceTabs(options({ initialState: session([group("primary", [], null)]) })));
    expect(result.current.groups[0]).toMatchObject({ tabs: [], activeId: null });
  });
});

describe("Home shortcuts", () => {
  function mount(extra: Partial<Parameters<typeof useWorkspaceShortcutActions>[0]> = {}) {
    const calls = { createNewTab: vi.fn(), openHome: vi.fn(), closeTab: vi.fn(), exportDocument: vi.fn(), fileDraft: vi.fn() };
    const view = renderHook(() =>
      useWorkspaceShortcutActions({
        sidebarMode: "explore", setSidebarMode: vi.fn(), searchInputRef: { current: null },
        groups: [group("primary", [HOME_TAB_ID], HOME_TAB_ID)], activeGroupId: "primary", documents: {},
        createNewTab: calls.createNewTab, activateTab: vi.fn(), closeTab: calls.closeTab, fileDraft: calls.fileDraft,
        flushDocument: vi.fn().mockResolvedValue(undefined), exportDocument: calls.exportDocument, openSettings: vi.fn(),
        openHome: calls.openHome, ...extra,
      }),
    );
    return { ...view, calls };
  }

  it("keeps Cmd+T going straight to a new draft, skipping Home", () => {
    const { calls, unmount } = mount();
    fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(calls.createNewTab).toHaveBeenCalledOnce();
    expect(calls.openHome).not.toHaveBeenCalled();
    unmount();
  });

  it("reopens Home with Cmd/Ctrl+Shift+H without touching other shortcuts", () => {
    const { calls, unmount } = mount();
    fireEvent.keyDown(window, { key: "H", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    expect(calls.openHome).toHaveBeenCalledTimes(2);
    expect(calls.createNewTab).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "h", metaKey: true });
    expect(calls.openHome).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("never saves or exports Home as a document", () => {
    const { calls, unmount } = mount();
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(calls.fileDraft).not.toHaveBeenCalled();
    unmount();
  });
});
