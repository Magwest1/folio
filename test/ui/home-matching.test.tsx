import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionAnchor, ActionItem } from "../../src/domain/types.ts";
import { HomeView } from "../../src/features/home/components/HomeView.tsx";

const NOW = new Date("2026-11-12T10:00:00Z");
const TITLES: Record<string, string> = { "/plan.md": "Finance plan", "/journal.md": "Journal", "/sync.md": "Sync notes" };

let counter = 0;
function action(overrides: Partial<ActionItem> = {}): ActionItem {
  counter += 1;
  return {
    id: `act_${counter}`, text: `Thing ${counter}`, kind: "task", person: null, due: null, status: "open", snoozedUntil: null,
    explicit: false, origin: "manual", editedByUser: false, anchor: null, createdAt: "2026-11-01T08:00:00Z",
    updatedAt: "2026-11-01T08:00:00Z", touchedAt: "2026-11-01T08:00:00Z", history: [], ...overrides,
  };
}

const anchor = (noteId: string, quote: string): ActionAnchor => ({ noteId, from: 3, to: 3 + quote.length, quote, orphaned: false });

/** Enough of /api/actions to answer the card buttons the way the real store does. */
function fakeServer(initial: ActionItem[]) {
  const store = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const writes: Array<{ method: string; path: string }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const wanted = url.searchParams.get("status")?.split(",");
      const all = [...store.values()];
      return json(wanted ? all.filter((item) => wanted.includes(item.status)) : all.filter((item) => ["suggested", "open", "snoozed"].includes(item.status)));
    }
    writes.push({ method, path: url.pathname });
    const [, , , id, ...step] = url.pathname.split("/");
    const item = store.get(id);
    if (!item) return json({ error: "Action not found." }, 404);
    const name = step.join("/");
    if (name === "completion/accept") {
      item.history.push({ at: NOW.toISOString(), from: item.status, to: "done", by: "user" });
      item.status = "done";
      item.completionSuggestion = null;
    } else if (name === "completion/dismiss") item.completionSuggestion = null;
    else if (name === "undo") {
      const last = item.history.pop();
      if (last) item.status = last.from;
      item.completion = null;
    }
    return json(item);
  });
  return { fetchMock, writes };
}

function renderHome() {
  const onOpenSource = vi.fn();
  const view = render(
    <HomeView
      bundleId="bundle-a" groupId="primary" active focusRequest={0} titleForNote={(id) => (id ? (TITLES[id] ?? null) : null)}
      pollMs={600_000} now={() => NOW} timeZone="UTC" onFileCapture={vi.fn()} onOpenAsDraft={vi.fn()} onOpenSource={onOpenSource}
    />,
  );
  return { ...view, onOpenSource };
}

const cardOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("Home completion suggestions", () => {
  const suggested = () =>
    action({
      text: "Send the budget to Anna", due: { date: "2026-11-12" }, anchor: anchor("/plan.md", "Send the budget to Anna"),
      completionSuggestion: { noteId: "/journal.md", quote: "Emailed the budget to Anna.", from: 5, to: 32, score: 0.74, at: "2026-11-11T09:00:00Z" },
    });

  it("asks quietly, with the passage and its note, and nothing else", async () => {
    vi.stubGlobal("fetch", fakeServer([suggested()]).fetchMock);
    renderHome();
    await screen.findByText("Send the budget to Anna");
    const card = cardOf("Send the budget to Anna");
    expect(within(card).getByText(/Looks done\? “Emailed the budget to Anna\.” · Journal/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Mark Send the budget to Anna done" })).toHaveTextContent("Mark done");
    expect(within(card).getByRole("button", { name: "Send the budget to Anna is not done yet" })).toHaveTextContent("Not yet");
  });

  it("marks the item done on Mark done, with an undo toast", async () => {
    const server = fakeServer([suggested()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Send the budget to Anna");
    fireEvent.click(screen.getByRole("button", { name: "Mark Send the budget to Anna done" }));
    expect(cardOf("Send the budget to Anna")).toHaveClass("is-completed");
    expect(screen.queryByText(/Looks done\?/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Marked done.");
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", path: `/api/actions/act_${counter}/completion/accept` }]));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.writes.at(-1)?.path).toMatch(/\/undo$/));
  });

  it("drops the line on Not yet and keeps the item exactly where it was", async () => {
    const server = fakeServer([suggested()]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Send the budget to Anna");
    fireEvent.click(screen.getByRole("button", { name: "Send the budget to Anna is not done yet" }));
    expect(screen.queryByText(/Looks done\?/)).not.toBeInTheDocument();
    expect(cardOf("Send the budget to Anna")).not.toHaveClass("is-completed");
    await waitFor(() => expect(server.writes.map((write) => write.path)).toEqual([expect.stringMatching(/\/completion\/dismiss$/)]));
  });

  it("opens the evidence passage from See where", async () => {
    vi.stubGlobal("fetch", fakeServer([suggested()]).fetchMock);
    const { onOpenSource } = renderHome();
    await screen.findByText("Send the budget to Anna");
    fireEvent.click(screen.getByRole("button", { name: "Show where Send the budget to Anna looks done" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ text: "Send the budget to Anna" }), {
      noteId: "/journal.md", from: 5, to: 32, quote: "Emailed the budget to Anna.", orphaned: false,
    });
  });
});

describe("Home automatic completions", () => {
  const auto = (at: string) =>
    action({
      text: "Call Kari about the lease", status: "done", anchor: anchor("/plan.md", "Call Kari about the lease"),
      completion: { noteId: "/journal.md", quote: "Called Kari about the lease.", from: 0, to: 28, score: 0.98, at, auto: true },
      history: [{ at, from: "open", to: "done", by: "system", reason: "completion" }],
    });

  it("shows an item done by Folio in the last day, struck through, with where it came from and undo", async () => {
    const server = fakeServer([auto("2026-11-11T14:00:00Z")]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Call Kari about the lease");
    const card = cardOf("Call Kari about the lease");
    expect(card).toHaveClass("is-completed");
    expect(within(card).getByText(/marked done from Journal/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Undo marking Call Kari about the lease done" }));
    expect(screen.queryByText(/marked done from/)).not.toBeInTheDocument();
    expect(cardOf("Call Kari about the lease")).not.toHaveClass("is-completed");
    expect(screen.getByRole("status")).toHaveTextContent("Back on your list.");
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", path: `/api/actions/act_${counter}/undo` }]));
  });

  it("leaves the board after a day", async () => {
    vi.stubGlobal("fetch", fakeServer([auto("2026-11-10T08:00:00Z")]).fetchMock);
    renderHome();
    await screen.findByText("Nothing needs you right now.");
    expect(screen.queryByText("Call Kari about the lease")).not.toBeInTheDocument();
  });
});

describe("Home repeated commitments", () => {
  const merged = () =>
    action({
      text: "Renew the parking permit", due: { date: "2026-11-12" }, anchor: anchor("/plan.md", "Renew the parking permit"),
      anchors: [anchor("/sync.md", "I have to renew the parking permit."), anchor("/journal.md", "Renew the permit.")],
    });

  it("says which other notes mention it, in the meta line", async () => {
    vi.stubGlobal("fetch", fakeServer([merged()]).fetchMock);
    renderHome();
    await screen.findByText("Renew the parking permit");
    expect(within(cardOf("Renew the parking permit")).getByText("from Finance plan")).toBeInTheDocument();
    expect(within(cardOf("Renew the parking permit")).getByText("also in Sync notes, Journal")).toBeInTheDocument();
  });

  it("lists every note from Open source when there is more than one", async () => {
    vi.stubGlobal("fetch", fakeServer([merged()]).fetchMock);
    const { onOpenSource } = renderHome();
    await screen.findByText("Renew the parking permit");
    fireEvent.click(within(cardOf("Renew the parking permit")).getByRole("button", { name: "Open source" }));
    expect(onOpenSource).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Notes that mention Renew the parking permit" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Finance plan", "Sync notes", "Journal"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sync notes" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ text: "Renew the parking permit" }), expect.objectContaining({ noteId: "/sync.md" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the only source straight away", async () => {
    vi.stubGlobal("fetch", fakeServer([action({ text: "Single note task", due: { date: "2026-11-12" }, anchor: anchor("/plan.md", "Single") })]).fetchMock);
    const { onOpenSource } = renderHome();
    await screen.findByText("Single note task");
    fireEvent.click(within(cardOf("Single note task")).getByRole("button", { name: "Open source" }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
