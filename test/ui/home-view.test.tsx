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

/** Eight dated items on the six days after today: a busy week, so every day keeps its own column. */
const fill = () =>
  Array.from({ length: 8 }, (_, index) =>
    action({ id: `fill_${index}`, text: `Filler ${index}`, due: { date: `2026-11-${13 + (index % 6)}` } }),
  );

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

const cardOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
const column = (name: string | RegExp) => screen.getByRole("region", { name });
const call = { noteId: "/notes/call.md", from: 0, to: 4, quote: "Send", orphaned: false };

function dataTransfer() {
  return { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" };
}

/** Drag a card (or chip) onto an element the way a browser sequences it. */
async function dragTo(card: HTMLElement, target: HTMLElement) {
  const transfer = dataTransfer();
  fireEvent.dragStart(card, { dataTransfer: transfer });
  fireEvent.dragEnter(target, { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });
  fireEvent.dragEnd(card, { dataTransfer: transfer });
}

describe("Home week storyboard", () => {
  it("lays the week out with calm wording and the source note", async () => {
    const server = fakeActionServer([
      action({ text: "Send the invoice", due: { date: "2026-11-10" }, anchor: call }),
      action({ text: "Book the venue", due: { date: "2026-11-13" } }),
      action({ text: "Ring the bank", due: { date: "2026-11-14", time: "09:30" }, person: "Kari" }),
      action({ text: "Plan the offsite", due: { window: { start: "2026-11-09", end: "2026-11-15" } } }),
      action({ text: "Renew the lease", due: { date: "2026-12-24" } }),
      action({ text: "Hear back on quote", kind: "waiting-on", person: "Ola", createdAt: "2026-11-09T09:00:00Z" }),
      action({ text: "Look into insurance" }),
      action({ text: "Maybe call Per", status: "suggested", origin: "suggested" }),
      action({ text: "Old idea", status: "faded" }),
      ...fill(),
    ]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Good morning. Thursday looks fairly light.");
    expect(screen.getByText("1 thing today · 1 waiting on others · 1 to confirm")).toBeInTheDocument();

    const today = column(/Today/);
    expect(within(today).getByText("from Tue")).toBeInTheDocument();
    expect(within(today).getByText("Send the invoice")).toBeInTheDocument();
    expect(within(today).getByText("from Call notes")).toBeInTheDocument();
    expect(within(column("fri 13")).getByText("Book the venue")).toBeInTheDocument();
    const saturday = column("sat 14");
    expect(within(saturday).getByText("Ring the bank")).toBeInTheDocument();
    expect(within(saturday).getByText("09:30")).toBeInTheDocument();
    expect(within(saturday).getByText("Kari")).toBeInTheDocument();
    expect(within(column("later")).getByText("Renew the lease")).toBeInTheDocument();
    expect(within(column("later")).getByText("24 dec")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "sometime this week" })).getByText("Plan the offsite")).toBeInTheDocument();

    expect(within(column("waiting on others")).getByText("Hear back on quote")).toBeInTheDocument();
    expect(within(column("waiting on others")).getByText("Ola · 3 days")).toBeInTheDocument();
    expect(within(column("loose ends")).getByText("Look into insurance")).toBeInTheDocument();
    const suggested = cardOf("Maybe call Per");
    expect(within(column("to confirm")).getByText("Maybe call Per")).toBeInTheDocument();
    expect(within(suggested).getByText("suggested")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/overdue|streak|behind/i);
    expect(screen.queryByText("Nothing needs you right now.")).not.toBeInTheDocument();

    const faded = screen.getByText("faded").closest("details") as HTMLDetailsElement;
    expect(faded.open).toBe(false);
    fireEvent.click(screen.getByText("faded"));
    const old = cardOf("Old idea");
    expect(within(old).getByRole("button", { name: "Bring back" })).toBeInTheDocument();
    expect(within(old).getByRole("button", { name: "Not important" })).toBeInTheDocument();
  });

  it("separates earlier items from today's own with labelled lists", async () => {
    vi.stubGlobal("fetch", fakeActionServer([
      action({ text: "From Tuesday", due: { date: "2026-11-10" } }),
      action({ text: "Due today", due: { date: "2026-11-12" } }),
    ]).fetchMock);
    renderHome();
    await screen.findByText("From Tuesday");
    const today = column(/Today/);
    const earlier = within(today).getByRole("list", { name: "Due from Tue" });
    const own = within(today).getByRole("list", { name: "Due today" });
    expect(within(earlier).getByText("From Tuesday")).toBeInTheDocument();
    expect(within(earlier).queryByText("Due today")).not.toBeInTheDocument();
    expect(within(own).getByText("Due today")).toBeInTheDocument();
    expect(within(today).getByText("today", { selector: "p" })).toBeInTheDocument();
  });

  it("adds no sub-label when nothing is earlier", async () => {
    vi.stubGlobal("fetch", fakeActionServer([action({ text: "Only today", due: { date: "2026-11-12" } })]).fetchMock);
    renderHome();
    await screen.findByText("Only today");
    expect(within(column(/Today/)).queryByText("today", { selector: "p" })).not.toBeInTheDocument();
  });

  it("gives every card Done, Snooze and Not important, and suggestions Accept and Not an action", async () => {
    vi.stubGlobal("fetch", fakeActionServer([
      action({ text: "Plain card", due: { date: "2026-11-13" } }),
      action({ text: "Suggested card", status: "suggested", origin: "suggested", due: { date: "2026-11-13" } }),
    ]).fetchMock);
    renderHome();
    await screen.findByText("Plain card");
    const names = (card: HTMLElement) => within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(names(cardOf("Plain card"))).toEqual(["Done", "Snooze", "Edit", "Not important"]);
    expect(names(cardOf("Suggested card"))).toEqual(["Accept", "Snooze", "Edit", "Not an action", "Not important"]);
    expect(within(column("fri 13")).getAllByRole("list")[0]).toBeInTheDocument();
  });

  it("shows the empty week as a calm, open board with no 'nothing here' text on the days", async () => {
    vi.stubGlobal("fetch", fakeActionServer([action({ status: "faded" })]).fetchMock);
    renderHome();
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Thursday is wide open.");
    expect(field()).toBeInTheDocument();
    // Quiet time is a slim dashed range, not a row of empty days.
    expect(column("fri–sun")).toHaveClass("is-empty");
    expect(column("fri–sun")).toHaveTextContent(/^fri–sun$/);
    expect(column("mon–wed")).toHaveClass("is-empty");
    expect(column(/Today/)).toHaveClass("is-today");
  });

  it("opens the source note from a card", async () => {
    const item = action({ text: "Send the invoice", anchor: call });
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

describe("Home agenda fallback", () => {
  let width = 1200;
  let notify: ((width: number) => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        notify = (next) => callback([{ contentRect: { width: next } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    notify = null;
    width = 1200;
  });

  it("turns into a vertical agenda in a narrow pane with the same cards and actions", async () => {
    width = 520;
    const item = action({ text: "Book the venue", due: { date: "2026-11-13" } });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    const { container } = renderHome();
    const view = container.querySelector("[data-home-view]") as HTMLElement;
    await screen.findByText("Book the venue");
    expect(view).toHaveAttribute("data-layout", "agenda");
    expect(container.querySelector("[data-home-board]")).toHaveAttribute("data-layout", "agenda");
    // The same days, in order, each with its heading and list.
    expect(screen.getAllByRole("heading", { level: 2 }).slice(0, 3).map((heading) => heading.textContent)).toEqual([
      "Today thu 12", "fri 13", "sat–sun",
    ]);
    fireEvent.click(within(cardOf("Book the venue")).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/complete` }));

    // Widening the pane brings the board back.
    act(() => notify?.(1100));
    expect(view).toHaveAttribute("data-layout", "board");
    act(() => notify?.(639));
    expect(view).toHaveAttribute("data-layout", "agenda");
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

  it("completes into a quiet struck-through card, and snoozes with presets", async () => {
    const done = action({ text: "Pay the bill", due: { date: "2026-11-12" } });
    const later = action({ text: "Water the plants" });
    const server = fakeActionServer([done, later]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Pay the bill");

    fireEvent.click(within(cardOf("Pay the bill")).getByRole("button", { name: "Done" }));
    // It stays in today, dimmed, until tomorrow.
    expect(cardOf("Pay the bill")).toHaveClass("is-completed");
    expect(within(cardOf("Pay the bill")).getByRole("button", { name: "Bring back" })).toBeInTheDocument();
    expect(within(cardOf("Pay the bill")).queryByRole("button", { name: "Snooze" })).not.toBeInTheDocument();

    fireEvent.click(within(cardOf("Water the plants")).getByRole("button", { name: "Snooze" }));
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

  it("keeps an item finished today in the Today column after a reload of the data", async () => {
    const finished = action({
      text: "Sent it already",
      status: "done",
      history: [{ at: "2026-11-12T07:00:00Z", from: "open", to: "done", by: "user" }],
    });
    vi.stubGlobal("fetch", fakeActionServer([finished]).fetchMock);
    renderHome();
    expect(await screen.findByText("Sent it already")).toBeInTheDocument();
    expect(within(column(/Today/)).getByText("Sent it already")).toBeInTheDocument();
    expect(cardOf("Sent it already")).toHaveClass("is-completed");
  });

  it("puts a card back and says so when the server refuses", async () => {
    const server = fakeActionServer([action({ text: "Stay put" })]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Stay put");
    server.failWrites();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("That didn't go through"));
    expect(cardOf("Stay put")).not.toHaveClass("is-completed");
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
    expect(within(column("fri 13")).getByText("Call Per tomorrow")).toBeInTheDocument();
    await waitFor(() => expect(server.writes()).toEqual([
      { method: "PATCH", path: `/api/actions/${item.id}`, body: { text: "Call Per tomorrow", due: { date: "2026-11-13" } } },
    ]));
  });

  it("offers undo for an automatically added item", async () => {
    const item = action({ text: "Send the draft", origin: "auto", createdAt: "2026-11-12T08:00:00Z", anchor: call });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    expect(await screen.findByText(/added from Call notes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo adding Send the draft" }));
    expect(screen.queryByText("Send the draft")).not.toBeInTheDocument();
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/reject` }));
  });

  it("brings a faded item back, or lets it go for good", async () => {
    const first = action({ text: "Faded one", status: "faded" });
    const second = action({ text: "Faded two", status: "faded" });
    const server = fakeActionServer([first, second]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    fireEvent.click(await screen.findByText("faded"));
    fireEvent.click(within(cardOf("Faded one")).getByRole("button", { name: "Bring back" }));
    fireEvent.click(within(cardOf("Faded two")).getByRole("button", { name: "Not important" }));
    await waitFor(() => expect(server.writes().map((write) => write.path)).toEqual([
      `/api/actions/${first.id}/reopen`,
      `/api/actions/${second.id}/let-go`,
    ]));
    expect(within(column("loose ends")).getByText("Faded one")).toBeInTheDocument();
  });
});

describe("Home drag and drop", () => {
  it("drops a card on another day and sets its date, keeping the time", async () => {
    const item = action({ text: "Ring the bank", due: { date: "2026-11-12", time: "09:30" } });
    const server = fakeActionServer([item, ...fill()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Ring the bank");
    await dragTo(cardOf("Ring the bank"), column("sat 14"));
    expect(within(column("sat 14")).getByText("Ring the bank")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Moved to Saturday 14.");
    await waitFor(() => expect(server.writes()).toEqual([
      { method: "PATCH", path: `/api/actions/${item.id}`, body: { due: { date: "2026-11-14", time: "09:30" } } },
    ]));
  });

  it("undoes a move through the toast", async () => {
    const item = action({ text: "Ring the bank", due: { date: "2026-11-13" } });
    const server = fakeActionServer([item, ...fill()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Ring the bank");
    await dragTo(cardOf("Ring the bank"), column("sat 14"));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(column("fri 13")).getByText("Ring the bank")).toBeInTheDocument();
    await waitFor(() => expect(server.writes().at(-1)).toEqual({
      method: "PATCH", path: `/api/actions/${item.id}`, body: { due: { date: "2026-11-13" } },
    }));
  });

  it("drops onto Later, the loose ends, and from the tray onto a day", async () => {
    const dated = action({ text: "Dated one", due: { date: "2026-11-13" } });
    const loose = action({ text: "Loose one" });
    const waiting = action({ text: "Waiting one", kind: "waiting-on", person: "Ola" });
    const server = fakeActionServer([dated, loose, waiting, ...fill()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Dated one");

    await dragTo(cardOf("Dated one"), column("later"));
    expect(within(column("later")).getByText("Dated one")).toBeInTheDocument();
    await dragTo(cardOf("Dated one"), column("loose ends"));
    expect(within(column("loose ends")).getByText("Dated one")).toBeInTheDocument();
    await dragTo(cardOf("Loose one"), column("mon 16"));
    expect(within(column("mon 16")).getByText("Loose one")).toBeInTheDocument();
    await dragTo(cardOf("Waiting one"), column("tue 17"));
    expect(within(column("tue 17")).getByText("Waiting one")).toBeInTheDocument();

    // Requests for one action keep their order; different actions are independent.
    await waitFor(() => expect(server.writes()).toHaveLength(4));
    const bodiesFor = (id: string) => server.writes().filter((write) => write.path.endsWith(id)).map((write) => write.body);
    expect(bodiesFor(dated.id)).toEqual([{ due: { date: "2026-11-19" } }, { due: null }]);
    expect(bodiesFor(loose.id)).toEqual([{ due: { date: "2026-11-16" } }]);
    expect(bodiesFor(waiting.id)).toEqual([{ due: { date: "2026-11-17" } }]);
    // A waiting item keeps its kind: only the follow-up date changed.
    expect(server.store.get(waiting.id)?.kind).toBe("waiting-on");
  });

  it("shows a Let go zone only while dragging, and dropping there is Not important", async () => {
    const item = action({ text: "Not for me", due: { date: "2026-11-13" } });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Not for me");
    expect(screen.queryByText("Let go")).not.toBeInTheDocument();

    const transfer = dataTransfer();
    fireEvent.dragStart(cardOf("Not for me"), { dataTransfer: transfer });
    const zone = (await screen.findByText("Let go")).closest(".let-go-zone") as HTMLElement;
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    expect(zone).toHaveClass("is-over");
    fireEvent.drop(zone, { dataTransfer: transfer });
    expect(screen.queryByText("Not for me")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Let go")).not.toBeInTheDocument());
    await waitFor(() => expect(server.writes()).toEqual([{ method: "POST", path: `/api/actions/${item.id}/let-go`, body: {} }]));
  });

  it("highlights the target while hovering and ignores drags that did not start on a card", async () => {
    vi.stubGlobal("fetch", fakeActionServer([action({ text: "Mover", due: { date: "2026-11-13" } }), ...fill()]).fetchMock);
    renderHome();
    await screen.findByText("Mover");
    const transfer = dataTransfer();
    // A file dragged in from outside is left alone.
    expect(fireEvent.dragOver(column("sat 14"), { dataTransfer: transfer })).toBe(true);
    fireEvent.dragStart(cardOf("Mover"), { dataTransfer: transfer });
    fireEvent.dragOver(column("sat 14"), { dataTransfer: transfer });
    expect(column("sat 14")).toHaveClass("is-over");
    fireEvent.dragLeave(column("sat 14"), { dataTransfer: transfer, relatedTarget: document.body });
    expect(column("sat 14")).not.toHaveClass("is-over");
    fireEvent.dragEnd(cardOf("Mover"), { dataTransfer: transfer });
  });
});

describe("Home adaptive columns", () => {
  it("drops onto a range column and gives the card that window", async () => {
    const item = action({ text: "Mover", due: { date: "2026-11-13" } });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Mover");
    // A quiet week: the days after Friday are two slim ranges.
    expect(within(column("fri 13")).getByText("Mover")).toBeInTheDocument();
    await dragTo(cardOf("Mover"), column("mon–wed"));
    expect(within(column("mon–wed")).getByText("Mover")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Moved to Monday to Wednesday.");
    await waitFor(() => expect(server.writes()).toEqual([
      { method: "PATCH", path: `/api/actions/${item.id}`, body: { due: { window: { start: "2026-11-16", end: "2026-11-18" } } } },
    ]));
    // Undo puts the old date back.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(column("fri 13")).getByText("Mover")).toBeInTheDocument();
    await waitFor(() => expect(server.writes().at(-1)?.body).toEqual({ due: { date: "2026-11-13" } }));
  });

  it("zooms out to show what is due next month, with dates on the cards", async () => {
    vi.stubGlobal("fetch", fakeActionServer([
      action({ text: "Renew the lease", due: { date: "2026-12-24" } }),
      action({ text: "Plan Q1", due: { date: "2027-01-12" } }),
    ]).fetchMock);
    renderHome();
    await screen.findByText("Renew the lease");
    // Nothing hides behind Later, and a wide column names each card's date.
    expect(within(column("later")).queryByText("Renew the lease")).not.toBeInTheDocument();
    expect(within(cardOf("Renew the lease")).getByText(/^(\d{1,2} dec|[a-z]{3} \d{1,2})$/)).toBeInTheDocument();
  });

  it("moves into the next column with Shift+Right and names the bucket", async () => {
    const item = action({ text: "Mover", due: { date: "2026-11-13" } });
    const server = fakeActionServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Mover");
    cardOf("Mover").focus();
    fireEvent.keyDown(cardOf("Mover"), { key: "ArrowRight", shiftKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("Moved to Saturday to Sunday.");
    // With nothing else due, the quiet days merge, and the card sits inside that wider column.
    expect(within(column("fri–sun")).getByText("Mover")).toBeInTheDocument();
    await waitFor(() => expect(server.writes()[0].body).toEqual({ due: { window: { start: "2026-11-14", end: "2026-11-15" } } }));
  });

  it("holds the columns still while a card is in the air", async () => {
    const server = fakeActionServer([action({ text: "Mover", due: { date: "2026-11-13" } })]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Mover");
    const transfer = dataTransfer();
    fireEvent.dragStart(cardOf("Mover"), { dataTransfer: transfer });
    await screen.findByText("Let go");
    // Arrivals during a drag change the data, not the columns under the pointer.
    const before = [...document.querySelectorAll("[data-column]")].map((element) => element.getAttribute("data-date"));
    server.store.set("busy", action({ id: "busy", text: "Arrived", due: { date: "2026-12-10" } }));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(server.calls.filter((call) => call.method === "GET").length).toBeGreaterThan(2));
    expect([...document.querySelectorAll("[data-column]")].map((element) => element.getAttribute("data-date"))).toEqual(before);
    fireEvent.dragEnd(cardOf("Mover"), { dataTransfer: transfer });
    vi.restoreAllMocks();
    await waitFor(() => expect(screen.getByText("Arrived")).toBeInTheDocument());
  });
});

describe("Home board keyboard", () => {
  const suggestions = () => [
    action({ text: "First suggestion", status: "suggested", origin: "suggested" }),
    action({ text: "Second suggestion", status: "suggested", origin: "suggested" }),
    action({ text: "Third suggestion", status: "suggested", origin: "suggested" }),
  ];

  it("keeps one card in the tab order and walks the board with j/k and the arrows", async () => {
    vi.stubGlobal("fetch", fakeActionServer([
      action({ text: "Today one", due: { date: "2026-11-12" } }),
      action({ text: "Friday one", due: { date: "2026-11-13" } }),
      action({ text: "Loose one" }),
    ]).fetchMock);
    renderHome();
    await screen.findByText("Today one");
    expect(document.querySelectorAll('[data-board-card][tabindex="0"]')).toHaveLength(1);

    cardOf("Today one").focus();
    fireEvent.keyDown(cardOf("Today one"), { key: "j" });
    expect(cardOf("Friday one")).toHaveFocus();
    fireEvent.keyDown(cardOf("Friday one"), { key: "ArrowDown" });
    expect(cardOf("Loose one")).toHaveFocus();
    fireEvent.keyDown(cardOf("Loose one"), { key: "k" });
    fireEvent.keyDown(cardOf("Friday one"), { key: "ArrowLeft" });
    expect(cardOf("Today one")).toHaveFocus();
    fireEvent.keyDown(cardOf("Today one"), { key: "ArrowRight" });
    expect(cardOf("Friday one")).toHaveFocus();
    expect(cardOf("Friday one")).toHaveAttribute("tabindex", "0");
    expect(cardOf("Today one")).toHaveAttribute("tabindex", "-1");
  });

  it("opens the source with Enter on the card, but leaves Enter on a button alone", async () => {
    const item = action({ text: "Send the invoice", anchor: call });
    vi.stubGlobal("fetch", fakeActionServer([item]).fetchMock);
    const { onOpenSource } = renderHome();
    await screen.findByText("Send the invoice");
    const done = within(cardOf("Send the invoice")).getByRole("button", { name: "Done" });
    fireEvent.keyDown(done, { key: "Enter" });
    expect(onOpenSource).not.toHaveBeenCalled();
    fireEvent.keyDown(cardOf("Send the invoice"), { key: "Enter" });
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
  });

  it("moves a focused card a day with Shift+arrows and announces it", async () => {
    const item = action({ text: "Ring the bank", due: { date: "2026-11-13", time: "10:00" } });
    const server = fakeActionServer([item, ...fill()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Ring the bank");
    cardOf("Ring the bank").focus();

    fireEvent.keyDown(cardOf("Ring the bank"), { key: "ArrowRight", shiftKey: true });
    expect(within(column("sat 14")).getByText("Ring the bank")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Moved to Saturday 14.");
    // The card is rebuilt in its new column; the keyboard follows it.
    await waitFor(() => expect(cardOf("Ring the bank")).toHaveFocus());

    fireEvent.keyDown(cardOf("Ring the bank"), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(cardOf("Ring the bank"), { key: "ArrowLeft", shiftKey: true });
    expect(within(column(/Today/)).getByText("Ring the bank")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Moved to today.");
    // Never before today.
    fireEvent.keyDown(cardOf("Ring the bank"), { key: "ArrowLeft", shiftKey: true });
    expect(within(column(/Today/)).getByText("Ring the bank")).toBeInTheDocument();

    fireEvent.keyDown(cardOf("Ring the bank"), { key: "ArrowDown", shiftKey: true });
    expect(within(column("loose ends")).getByText("Ring the bank")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Moved to loose ends.");
    await waitFor(() => expect(server.writes().map((write) => write.body)).toEqual([
      { due: { date: "2026-11-14", time: "10:00" } },
      { due: { date: "2026-11-13", time: "10:00" } },
      { due: { date: "2026-11-12", time: "10:00" } },
      { due: null },
    ]));
  });

  it("moves with the triage keys and acts on whichever card has focus", async () => {
    const items = suggestions();
    const server = fakeActionServer(items);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("First suggestion");
    cardOf("First suggestion").focus();

    fireEvent.keyDown(cardOf("First suggestion"), { key: "j" });
    expect(cardOf("Second suggestion")).toHaveFocus();
    fireEvent.keyDown(cardOf("Second suggestion"), { key: "a" });
    // Accepted: it leaves the suggestions and joins the loose ends, and focus stays with the board.
    expect(within(column("to confirm")).queryByText("Second suggestion")).not.toBeInTheDocument();
    expect(within(column("loose ends")).getByText("Second suggestion")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement?.closest("[data-home-board]")).not.toBeNull());

    fireEvent.keyDown(cardOf("Third suggestion"), { key: "x" });
    await waitFor(() => expect(screen.queryByText("Third suggestion")).not.toBeInTheDocument());
    fireEvent.keyDown(cardOf("First suggestion"), { key: "n" });
    await waitFor(() => expect(screen.queryByText("First suggestion")).not.toBeInTheDocument());
    await waitFor(() => expect(server.writes().map((call) => call.path)).toEqual([
      `/api/actions/${items[1].id}/confirm`,
      `/api/actions/${items[2].id}/reject`,
      `/api/actions/${items[0].id}/let-go`,
    ]));
  });

  it("marks done with d, and snoozes with s then a number", async () => {
    const first = action({ text: "Finish report", due: { date: "2026-11-13" } });
    const second = action({ text: "Water the plants", due: { date: "2026-11-14" } });
    const server = fakeActionServer([first, second]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Finish report");

    cardOf("Finish report").focus();
    fireEvent.keyDown(cardOf("Finish report"), { key: "d" });
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${first.id}/complete` }));
    // Accept does nothing on a card that is not a suggestion.
    fireEvent.keyDown(cardOf("Water the plants"), { key: "a" });
    fireEvent.keyDown(cardOf("Water the plants"), { key: "x" });

    cardOf("Water the plants").focus();
    fireEvent.keyDown(cardOf("Water the plants"), { key: "s" });
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "2" });
    expect(screen.queryByText("Water the plants")).not.toBeInTheDocument();
    await waitFor(() => expect(server.writes()[1]).toMatchObject({
      path: `/api/actions/${second.id}/snooze`, body: { until: "2026-11-13T09:00:00.000Z" },
    }));
    expect(server.writes()).toHaveLength(2);
  });

  it("edits with e", async () => {
    vi.stubGlobal("fetch", fakeActionServer(suggestions()).fetchMock);
    renderHome();
    await screen.findByText("First suggestion");
    cardOf("First suggestion").focus();
    fireEvent.keyDown(cardOf("First suggestion"), { key: "e" });
    expect(screen.getByLabelText("What")).toHaveValue("First suggestion");
  });

  it("ignores board keys while typing, in forms, and when focus is outside the board", async () => {
    const items = suggestions();
    const server = fakeActionServer(items);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("First suggestion");

    // Typing in the writing field never triggers a key.
    for (const key of ["a", "n", "d", "x", "j"]) fireEvent.keyDown(field(), { key });
    expect(screen.getByText("First suggestion")).toBeInTheDocument();

    // Neither does focus that is not on a card in the board.
    fireEvent.keyDown(screen.getByRole("heading", { level: 1 }), { key: "n" });
    expect(screen.getByText("First suggestion")).toBeInTheDocument();

    cardOf("First suggestion").focus();
    fireEvent.keyDown(cardOf("First suggestion"), { key: "e" });
    const edit = screen.getByLabelText("What");
    fireEvent.keyDown(edit, { key: "n" });
    fireEvent.keyDown(edit, { key: "a" });
    fireEvent.keyDown(edit, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByText("Second suggestion")).toBeInTheDocument();
    expect(server.writes()).toHaveLength(0);
  });

  it("picks the thread back up from the board when no card is focused", async () => {
    vi.stubGlobal("fetch", fakeActionServer([action({ text: "Only card", due: { date: "2026-11-13" } })]).fetchMock);
    const { container } = renderHome();
    await screen.findByText("Only card");
    const board = container.querySelector("[data-home-board]") as HTMLElement;
    fireEvent.keyDown(board, { key: "j" });
    expect(cardOf("Only card")).toHaveFocus();
  });
});
