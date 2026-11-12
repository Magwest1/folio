import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionItem } from "../../src/domain/types.ts";
import { HomeView, type HomeViewProps } from "../../src/features/home/components/HomeView.tsx";
import { HOME_CAPTURE_STORAGE_KEY } from "../../src/features/home/model/capture-storage.ts";

const NOW = new Date("2026-11-12T10:00:00Z");

let counter = 0;
function action(overrides: Partial<ActionItem> = {}): ActionItem {
  counter += 1;
  return {
    id: `act_${counter}`,
    text: `Thing ${counter}`,
    kind: "task",
    person: null,
    due: null,
    status: "open",
    snoozedUntil: null,
    explicit: false,
    origin: "manual",
    editedByUser: false,
    anchor: null,
    createdAt: "2026-11-01T08:00:00Z",
    updatedAt: "2026-11-01T08:00:00Z",
    touchedAt: "2026-11-01T08:00:00Z",
    history: [],
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown };

/** A tiny stand-in for /api/actions with the same transitions as the real store. */
function fakeActionServer(initial: ActionItem[]) {
  const store = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const calls: Call[] = [];
  const gates: Array<() => void> = [];
  let hold = false;
  let fail = false;
  const STATUS: Record<string, ActionItem["status"]> = {
    confirm: "open", complete: "done", "let-go": "let-go", reject: "rejected", snooze: "snoozed", reopen: "open",
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === "GET") {
      const wanted = url.searchParams.get("status")?.split(",");
      const all = [...store.values()];
      return json(wanted ? all.filter((item) => wanted.includes(item.status)) : all.filter((item) => ["suggested", "open", "snoozed"].includes(item.status)));
    }
    if (hold) await new Promise<void>((resolve) => gates.push(resolve));
    if (fail) return json({ error: "nope" }, 500);
    const [, , , id, step] = url.pathname.split("/");
    const item = store.get(id);
    if (!item) return json({ error: "Action not found." }, 404);
    if (method === "PATCH") Object.assign(item, body, { editedByUser: true });
    else if (step === "undo") {
      const last = item.history.pop();
      if (last) {
        item.status = last.from;
        item.snoozedUntil = null;
      }
    } else {
      item.history.push({ at: NOW.toISOString(), from: item.status, to: STATUS[step], by: "user" });
      item.status = STATUS[step];
      item.snoozedUntil = step === "snooze" ? body.until : null;
    }
    return json(item);
  });
  return {
    store,
    calls,
    fetchMock,
    holdWrites: () => { hold = true; },
    releaseWrites: () => { hold = false; gates.splice(0).forEach((open) => open()); },
    failWrites: () => { fail = true; },
    writes: () => calls.filter((call) => call.method !== "GET"),
  };
}

function renderHome(props: Partial<HomeViewProps> = {}) {
  const handlers = {
    onFileCapture: vi.fn(),
    onOpenAsDraft: vi.fn(),
    onOpenSource: vi.fn(),
  };
  const view = render(
    <HomeView
      bundleId="bundle-a"
      groupId="primary"
      active
      focusRequest={0}
      titleForNote={(id) => (id === "/notes/call.md" ? "Call notes" : null)}
      pollMs={600_000}
      now={() => NOW}
      timeZone="UTC"
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

const field = () => screen.getByRole("textbox", { name: "Capture" });

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Home writing field", () => {
  it("is focused on arrival, with no click, and grows with its text", async () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    renderHome();
    expect(field()).toHaveFocus();
    // The friction acceptance: typing goes straight in.
    fireEvent.change(field(), { target: { value: "first line\nsecond line" } });
    expect(field()).toHaveValue("first line\nsecond line");
    await screen.findByText("Nothing needs you right now.");
  });

  it("never takes focus away from an open editor", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const editor = document.createElement("div");
    editor.className = "cm-content";
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    renderHome();
    expect(editor).toHaveFocus();
    editor.remove();
  });

  it("does not focus when its pane is not the active group, until asked", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const { rerender } = renderHome({ active: false });
    expect(field()).not.toHaveFocus();
    rerender(
      <HomeView
        bundleId="bundle-a" groupId="primary" active={false} focusRequest={1} titleForNote={() => null}
        pollMs={600_000} now={() => NOW} timeZone="UTC"
        onFileCapture={vi.fn()} onOpenAsDraft={vi.fn()} onOpenSource={vi.fn()}
      />,
    );
    expect(field()).toHaveFocus();
  });

  it("hands the text to filing on Cmd+Enter and empties the field", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const { onFileCapture, onOpenAsDraft } = renderHome();
    fireEvent.change(field(), { target: { value: "Met Kari about the roof" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onFileCapture).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(onFileCapture).toHaveBeenCalledWith("primary", "Met Kari about the roof");
    expect(onOpenAsDraft).not.toHaveBeenCalled();
    expect(field()).toHaveValue("");
    expect(window.localStorage.getItem(`${HOME_CAPTURE_STORAGE_KEY}:bundle-a`)).toBeNull();
  });

  it("opens the exact text as a draft with the shortcut or the button", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const { onOpenAsDraft, onFileCapture } = renderHome();
    const text = "  keep every\n\nline  ";
    fireEvent.change(field(), { target: { value: text } });
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true, shiftKey: true });
    expect(onOpenAsDraft).toHaveBeenCalledWith("primary", text);
    expect(onFileCapture).not.toHaveBeenCalled();
    expect(field()).toHaveValue("");

    fireEvent.change(field(), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Open as draft" }));
    expect(onOpenAsDraft).toHaveBeenLastCalledWith("primary", "again");
  });

  it("clears focus on Escape but keeps the text", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    renderHome();
    fireEvent.change(field(), { target: { value: "still here" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field()).not.toHaveFocus();
    expect(field()).toHaveValue("still here");
  });

  it("recovers unfinished text after a reload, per bundle", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const first = renderHome();
    fireEvent.change(field(), { target: { value: "half a thought" } });
    act(() => vi.advanceTimersByTime(300));
    expect(JSON.parse(window.localStorage.getItem(`${HOME_CAPTURE_STORAGE_KEY}:bundle-a`) ?? "{}")).toEqual({ text: "half a thought" });
    first.unmount();

    renderHome();
    expect(field()).toHaveValue("half a thought");
    cleanupRender();
    renderHome({ bundleId: "bundle-b" });
    expect(field()).toHaveValue("");
  });

  it("keeps text typed while the bundle is still being resolved", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    const props = {
      groupId: "primary", active: true, focusRequest: 0, titleForNote: () => null, pollMs: 600_000, now: () => NOW, timeZone: "UTC",
      onFileCapture: vi.fn(), onOpenAsDraft: vi.fn(), onOpenSource: vi.fn(),
    };
    const { rerender } = render(<HomeView bundleId="legacy-bundle" {...props} />);
    fireEvent.change(field(), { target: { value: "typed during startup" } });
    rerender(<HomeView bundleId="bundle-a" {...props} />);
    expect(field()).toHaveValue("typed during startup");
    expect(window.localStorage.getItem(`${HOME_CAPTURE_STORAGE_KEY}:bundle-a`)).toContain("typed during startup");
    expect(window.localStorage.getItem(`${HOME_CAPTURE_STORAGE_KEY}:legacy-bundle`)).toBeNull();
  });

  it("survives unavailable storage", () => {
    vi.stubGlobal("fetch", fakeActionServer([]).fetchMock);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderHome();
    fireEvent.change(field(), { target: { value: "works anyway" } });
    expect(field()).toHaveValue("works anyway");
    vi.restoreAllMocks();
  });
});

function cleanupRender() {
  document.body.innerHTML = "";
}

describe("Home sections", () => {
  it("renders sections from the store with calm wording and the source note", async () => {
    const server = fakeActionServer([
      action({ text: "Send the invoice", due: { date: "2026-11-10" }, anchor: { noteId: "/notes/call.md", from: 0, to: 4, quote: "Send", orphaned: false } }),
      action({ text: "Book the venue", due: { date: "2026-11-13" } }),
      action({ text: "Hear back on quote", kind: "waiting-on", person: "Ola", createdAt: "2026-11-09T09:00:00Z" }),
      action({ text: "Look into insurance" }),
      action({ text: "Maybe call Per", status: "suggested", origin: "suggested" }),
      action({ text: "Old idea", status: "faded" }),
    ]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();

    const now = (await screen.findByRole("heading", { name: "Now" })).closest("section") as HTMLElement;
    expect(within(now).getByText("Send the invoice")).toBeInTheDocument();
    expect(within(now).getByText("From Tuesday")).toBeInTheDocument();
    expect(within(now).getByText("from Call notes")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/overdue|streak|behind/i);
    expect(screen.getByRole("heading", { name: "Coming up" })).toBeInTheDocument();
    expect(screen.getByText("Book the venue")).toBeInTheDocument();
    expect(screen.getByText("since 3 days")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Loose ends" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "To confirm" })).toBeInTheDocument();
    const faded = screen.getByText(/Faded \(1\)/).closest("details") as HTMLDetailsElement;
    expect(faded.open).toBe(false);
    expect(screen.queryByText("Nothing needs you right now.")).not.toBeInTheDocument();
  });

  it("shows the warm empty state with the writing field in front", async () => {
    vi.stubGlobal("fetch", fakeActionServer([action({ status: "faded" })]).fetchMock);
    renderHome();
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(field()).toBeInTheDocument();
  });

  it("opens the source note from a card", async () => {
    const item = action({ text: "Send the invoice", anchor: { noteId: "/notes/call.md", from: 0, to: 4, quote: "Send", orphaned: false } });
    vi.stubGlobal("fetch", fakeActionServer([item]).fetchMock);
    const { onOpenSource } = renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "Open source" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
  });

  it("refreshes when the window regains focus", async () => {
    const server = fakeActionServer([]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Nothing needs you right now.");
    const before = server.calls.length;
    server.store.set("late", action({ id: "late", text: "Arrived in the background" }));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("Arrived in the background")).toBeInTheDocument();
    expect(server.calls.length).toBeGreaterThan(before);
    vi.restoreAllMocks();
  });

  it("polls lightly while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeActionServer([]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome({ pollMs: 30_000 });
    await screen.findByText("Nothing needs you right now.");
    server.store.set("late", action({ id: "late", text: "Polled in" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_500); });
    expect(await screen.findByText("Polled in")).toBeInTheDocument();
  });
});

describe("Home changes", () => {
  it("lets go permanently in one step, optimistically, and undoes through /undo", async () => {
    const item = action({ text: "Chase the plumber" });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Chase the plumber");

    server.holdWrites();
    fireEvent.click(screen.getByRole("button", { name: "Not important" }));
    // Gone at once, with no confirmation dialog and before the server answers.
    expect(screen.queryByText("Chase the plumber")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Let go. It won't come back.");
    server.releaseWrites();
    await waitFor(() => expect(server.writes()).toEqual([{ method: "POST", path: `/api/actions/${item.id}/let-go`, body: {} }]));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Chase the plumber")).toBeInTheDocument();
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ path: `/api/actions/${item.id}/undo` }));
    expect(server.store.get(item.id)?.status).toBe("open");
  });

  it("completes and snoozes with presets", async () => {
    const done = action({ text: "Pay the bill" });
    const later = action({ text: "Water the plants" });
    const server = fakeActionServer([done, later]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Pay the bill");

    const card = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
    fireEvent.click(within(card("Pay the bill")).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Pay the bill")).not.toBeInTheDocument();

    fireEvent.click(within(card("Water the plants")).getByRole("button", { name: "Snooze" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent?.replace(/\d$/, ""))).toEqual([
      "Later today", "Tomorrow morning", "Next week",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Tomorrow morning/ }));
    expect(screen.queryByText("Water the plants")).not.toBeInTheDocument();
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${done.id}/complete` });
    expect(server.writes()[1]).toMatchObject({ path: `/api/actions/${later.id}/snooze`, body: { until: "2026-11-13T09:00:00.000Z" } });
  });

  it("puts a card back and says so when the server refuses", async () => {
    const server = fakeActionServer([action({ text: "Stay put" })]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Stay put");
    server.failWrites();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Stay put")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("That didn't go through");
  });

  it("edits inline and saves with one request", async () => {
    const item = action({ text: "Call Per" });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Call Per");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("What");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Call Per tomorrow" } });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2026-11-13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Call Per tomorrow")).toBeInTheDocument();
    await waitFor(() => expect(server.writes()).toEqual([
      { method: "PATCH", path: `/api/actions/${item.id}`, body: { text: "Call Per tomorrow", due: { date: "2026-11-13" } } },
    ]));
  });

  it("offers undo for an automatically added item", async () => {
    const item = action({ text: "Send the draft", origin: "auto", createdAt: "2026-11-12T08:00:00Z", anchor: { noteId: "/notes/call.md", from: 0, to: 4, quote: "Send", orphaned: false } });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    expect(await screen.findByText(/Added from Call notes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo adding Send the draft" }));
    expect(screen.queryByText("Send the draft")).not.toBeInTheDocument();
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/reject` }));
  });
});

describe("To confirm keyboard triage", () => {
  const suggestions = () => [
    action({ text: "First suggestion", status: "suggested", origin: "suggested" }),
    action({ text: "Second suggestion", status: "suggested", origin: "suggested" }),
    action({ text: "Third suggestion", status: "suggested", origin: "suggested" }),
  ];
  const list = () => screen.getByRole("group", { name: "Suggestions to confirm" });

  it("moves with j/k and acts on the highlighted suggestion", async () => {
    const items = suggestions();
    const server = fakeActionServer(items);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("First suggestion");
    list().focus();
    expect(list()).toHaveAttribute("aria-activedescendant", `home-confirm-${items[0].id}`);

    fireEvent.keyDown(list(), { key: "j" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "k" });
    expect(list()).toHaveAttribute("aria-activedescendant", `home-confirm-${items[1].id}`);

    fireEvent.keyDown(list(), { key: "a" });
    // Accepted: it leaves the suggestions and joins the loose ends.
    expect(within(list()).queryByText("Second suggestion")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Loose ends" })).toBeInTheDocument();
    // The cursor stays on the same position, now the next suggestion.
    expect(list()).toHaveAttribute("aria-activedescendant", `home-confirm-${items[2].id}`);
    fireEvent.keyDown(list(), { key: "x" });
    await waitFor(() => expect(screen.queryByText("Third suggestion")).not.toBeInTheDocument());
    fireEvent.keyDown(list(), { key: "n" });
    await waitFor(() => expect(screen.queryByText("First suggestion")).not.toBeInTheDocument());
    await waitFor(() => expect(server.writes().map((call) => call.path)).toEqual([
      `/api/actions/${items[1].id}/confirm`,
      `/api/actions/${items[2].id}/reject`,
      `/api/actions/${items[0].id}/let-go`,
    ]));
  });

  it("snoozes with s then a number, and edits with e", async () => {
    const items = suggestions();
    const server = fakeActionServer(items);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("First suggestion");
    list().focus();

    fireEvent.keyDown(list(), { key: "s" });
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "2" });
    expect(screen.queryByText("First suggestion")).not.toBeInTheDocument();
    await waitFor(() => expect(server.writes()[0]).toMatchObject({
      path: `/api/actions/${items[0].id}/snooze`, body: { until: "2026-11-13T09:00:00.000Z" },
    }));

    fireEvent.keyDown(list(), { key: "e" });
    expect(screen.getByLabelText("What")).toHaveValue("Second suggestion");
  });

  it("ignores triage keys while typing and when the list lacks focus", async () => {
    const items = suggestions();
    const server = fakeActionServer(items);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("First suggestion");

    // Typing in the writing field never triggers a triage key.
    fireEvent.keyDown(field(), { key: "a" });
    fireEvent.keyDown(field(), { key: "n" });
    expect(screen.getByText("First suggestion")).toBeInTheDocument();

    list().focus();
    fireEvent.keyDown(list(), { key: "e" });
    const edit = screen.getByLabelText("What");
    fireEvent.keyDown(edit, { key: "n" });
    fireEvent.keyDown(edit, { key: "a" });
    expect(screen.getByText("Second suggestion")).toBeInTheDocument();
    expect(server.writes()).toHaveLength(0);
  });
});
