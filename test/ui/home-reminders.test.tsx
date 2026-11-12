import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionItem, ReminderCheckin, ReminderItem } from "../../src/domain/types.ts";
import { HomeView } from "../../src/features/home/components/HomeView.tsx";

const NOW = new Date("2026-11-12T10:00:00Z");

let counter = 0;
function action(overrides: Partial<ActionItem> = {}): ActionItem {
  counter += 1;
  return {
    id: `act_${counter}`, text: `Thing ${counter}`, kind: "task", person: null, due: null, status: "open", snoozedUntil: null,
    explicit: false, origin: "auto", editedByUser: false, anchor: null, createdAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:00:00Z", touchedAt: "2026-10-01T08:00:00Z", history: [], ...overrides,
  };
}

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

/** A small stand-in for the action and reminder endpoints. */
function fakeServer(initial: ActionItem[], options: { reminders?: ReminderItem[]; checkins?: ReminderCheckin[] } = {}) {
  const store = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const calls: Call[] = [];
  const state = { reminders: options.reminders ?? [], checkins: options.checkins ?? [], phraseError: "" };
  const STATUS: Record<string, ActionItem["status"]> = { complete: "done", "let-go": "let-go", snooze: "snoozed", keep: "open", undo: "open" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/reminders/pending") return json({ reminders: state.reminders, checkins: state.checkins });
    if (url.pathname.startsWith("/api/reminders/")) return json({ acked: true });
    if (url.pathname === "/api/actions/clear-note") {
      const ids = [...store.values()].filter((item) => item.anchor?.noteId === body?.noteId && item.status === "open").map((item) => item.id);
      for (const id of ids) store.get(id)!.status = "let-go";
      return json({ ids });
    }
    if (url.pathname === "/api/actions/undo-batch") {
      for (const id of (body?.ids as string[]) ?? []) store.get(id)!.status = "open";
      return json({ ids: body?.ids });
    }
    if (method === "GET") {
      const wanted = url.searchParams.get("status")?.split(",");
      const all = [...store.values()];
      return json(wanted ? all.filter((item) => wanted.includes(item.status)) : all.filter((item) => ["suggested", "open", "snoozed"].includes(item.status)));
    }
    const [, , , id, step] = url.pathname.split("/");
    const item = store.get(id);
    if (!item) return json({ error: "Action not found." }, 404);
    if (step === "snooze" && body?.phrase !== undefined) {
      if (state.phraseError) return json({ error: state.phraseError }, 400);
      item.status = "snoozed";
      item.snoozedUntil = "2026-11-13T09:00:00.000Z";
      return json({ ...item, until: item.snoozedUntil });
    }
    item.status = STATUS[step];
    if (step === "snooze") item.snoozedUntil = String(body?.until);
    if (step === "keep") item.touchedAt = NOW.toISOString();
    return json(item);
  });
  return { store, calls, state, fetchMock, writes: () => calls.filter((entry) => entry.method !== "GET") };
}

function renderHome() {
  return render(
    <HomeView
      bundleId="bundle-a" groupId="primary" active focusRequest={0}
      titleForNote={(id) => (id === "/notes/call.md" ? "Call notes" : null)}
      onFileCapture={vi.fn()} onOpenAsDraft={vi.fn()} onOpenSource={vi.fn()}
      pollMs={600_000} now={() => NOW} timeZone="UTC"
    />,
  );
}

const cardOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
const reminder = (overrides: Partial<ReminderItem> = {}): ReminderItem => ({
  id: "rem_1", kind: "action", title: "Pay the invoice", body: "Due today", actionIds: [], at: NOW.toISOString(), level: "gentle", silent: true, ...overrides,
});

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.folio;
});

describe("plain-language snooze", () => {
  it("sends the words and the time zone, then shows the resolved time in an undo toast", async () => {
    const item = action({ text: "Water the plants" });
    const server = fakeServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Water the plants");
    fireEvent.click(within(cardOf("Water the plants")).getByRole("button", { name: "Snooze" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);

    const field = within(menu).getByRole("textbox", { name: /own words/ });
    fireEvent.change(field, { target: { value: "tomorrow after lunch" } });
    fireEvent.keyDown(field, { key: "2" });
    expect(server.writes()).toHaveLength(0);
    fireEvent.submit(field.closest("form") as HTMLFormElement);

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/snooze`, body: { phrase: "tomorrow after lunch", timeZone: "UTC" } });
    expect(await screen.findByText("Snoozed until Fri 13, 09:00.")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("Water the plants")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Water the plants")).toBeInTheDocument();
    expect(server.writes().at(-1)).toMatchObject({ path: `/api/actions/${item.id}/undo` });
  });

  it("keeps the menu open and shows the server's friendly message when the words can't be read", async () => {
    const server = fakeServer([action({ text: "Water the plants" })]);
    server.state.phraseError = 'I couldn\'t read "blorp" as a time. Try something like "tomorrow morning".';
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Water the plants");
    fireEvent.click(within(cardOf("Water the plants")).getByRole("button", { name: "Snooze" }));
    const field = screen.getByRole("textbox", { name: /own words/ });
    fireEvent.change(field, { target: { value: "blorp" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Try something like/);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Water the plants")).toBeInTheDocument();
  });

  it("still snoozes with the 1/2/3 keys from the presets", async () => {
    const item = action({ text: "Water the plants" });
    const server = fakeServer([item]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Water the plants");
    fireEvent.click(within(cardOf("Water the plants")).getByRole("button", { name: "Snooze" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "2" });
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ body: { until: "2026-11-13T09:00:00.000Z" } });
  });
});

describe("still relevant?", () => {
  const quiet = () => action({ text: "Look into solar panels" });

  it("asks quietly on the card, with Keep and Let go and no badge or counter", async () => {
    const item = quiet();
    const server = fakeServer([item, action({ text: "Other thing" })], { checkins: [{ actionId: item.id, since: "2026-11-12T09:00:00Z" }] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Look into solar panels");
    const card = cardOf("Look into solar panels");
    expect(await within(card).findByText(/Still relevant\?/)).toBeInTheDocument();
    expect(within(cardOf("Other thing")).queryByText(/Still relevant\?/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Still relevant\?/)).toHaveLength(1);
    expect(document.querySelector("[data-home-view] .badge, [data-home-view] [data-badge]")).toBeNull();
  });

  it("Keep resets the clock and removes the question for good", async () => {
    const item = quiet();
    const server = fakeServer([item], { checkins: [{ actionId: item.id, since: "2026-11-12T09:00:00Z" }] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Look into solar panels");
    fireEvent.click(await within(cardOf("Look into solar panels")).findByRole("button", { name: /^Keep/ }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/keep` });
    expect(within(cardOf("Look into solar panels")).queryByText(/Still relevant\?/)).not.toBeInTheDocument();
    expect(screen.getByText("Kept. I won't ask again for a while.")).toBeInTheDocument();
  });

  it("Let go is permanent in one step", async () => {
    const item = quiet();
    const server = fakeServer([item], { checkins: [{ actionId: item.id, since: "2026-11-12T09:00:00Z" }] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Look into solar panels");
    fireEvent.click(await within(cardOf("Look into solar panels")).findByRole("button", { name: /^Let go of/ }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ path: `/api/actions/${item.id}/let-go` });
    expect(screen.queryByText("Look into solar panels")).not.toBeInTheDocument();
  });
});

describe("in-app reminders", () => {
  it("shows a due reminder once as a quiet toast and acks it, with the same three choices", async () => {
    const item = action({ text: "Pay the invoice", due: { date: "2026-11-12" } });
    const server = fakeServer([item], { reminders: [reminder({ actionIds: [item.id] })] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    const toast = (await screen.findByText("Reminder")).closest(".home-toast") as HTMLElement;
    expect(within(toast).getByText("Pay the invoice")).toBeInTheDocument();
    expect(within(toast).getByText("Due today")).toBeInTheDocument();
    expect(within(toast).getAllByRole("button").map((button) => button.textContent)).toEqual(["Done", "Snooze", "Not important"]);
    await waitFor(() => expect(server.calls.some((entry) => entry.path === "/api/reminders/rem_1/ack")).toBe(true));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(server.calls.filter((entry) => entry.path === "/api/reminders/pending").length).toBeGreaterThan(1));
    expect(screen.getAllByText("Reminder")).toHaveLength(1);
    expect(server.calls.filter((entry) => entry.path === "/api/reminders/rem_1/ack")).toHaveLength(1);
  });

  it("Not important in the toast removes the item for good", async () => {
    const item = action({ text: "Pay the invoice", due: { date: "2026-11-12" } });
    const server = fakeServer([item], { reminders: [reminder({ actionIds: [item.id] })] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    const toast = (await screen.findByText("Reminder")).closest(".home-toast") as HTMLElement;
    fireEvent.click(within(toast).getByRole("button", { name: "Not important" }));
    await waitFor(() => expect(server.writes().some((entry) => entry.path === `/api/actions/${item.id}/let-go`)).toBe(true));
    expect(screen.queryByText("Due today")).not.toBeInTheDocument();
  });

  it("Done and Snooze from the toast act on the card", async () => {
    const first = action({ text: "Pay the invoice", due: { date: "2026-11-12" } });
    const second = action({ text: "Book the flight", due: { date: "2026-11-12" } });
    const server = fakeServer([first, second], {
      reminders: [reminder({ id: "rem_a", actionIds: [first.id] }), reminder({ id: "rem_b", title: "Book the flight", actionIds: [second.id] })],
    });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await waitFor(() => expect(screen.getAllByText("Reminder")).toHaveLength(2));
    const toasts = document.querySelectorAll<HTMLElement>(".home-toast.is-reminder");
    fireEvent.click(within(toasts[0]).getByRole("button", { name: "Done" }));
    fireEvent.click(within(toasts[1]).getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `/api/actions/${first.id}/complete` }),
      expect.objectContaining({ path: `/api/actions/${second.id}/snooze`, body: { until: "2026-11-13T09:00:00.000Z" } }),
    ]));
  });

  it("a merged reminder only offers Dismiss, so one click never lets go of things unseen", async () => {
    const server = fakeServer([], { reminders: [reminder({ kind: "group", title: "3 things for this morning", body: "A · B · C", actionIds: ["a", "b", "c"] })] });
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    const toast = (await screen.findByText("3 things for this morning")).closest(".home-toast") as HTMLElement;
    expect(within(toast).getAllByRole("button").map((button) => button.textContent)).toEqual(["Dismiss"]);
  });

  it("shows no renderer toast, and acks nothing, when the desktop shell already delivered it natively", async () => {
    const item = action({ text: "Pay the invoice", due: { date: "2026-11-12" } });
    const server = fakeServer([item], { reminders: [reminder({ actionIds: [item.id] })], checkins: [{ actionId: item.id, since: "2026-11-12T09:00:00Z" }] });
    vi.stubGlobal("fetch", server.fetchMock);
    const deliversNatively = vi.fn(async () => true);
    window.folio = { reminders: { deliversNatively, onFocusAction: () => () => undefined } };
    renderHome();
    await within(await screen.findByText("Pay the invoice").then((node) => node.closest("li") as HTMLElement)).findByText(/Still relevant\?/);
    await act(async () => undefined);
    expect(deliversNatively).toHaveBeenCalled();
    expect(screen.queryByText("Reminder")).not.toBeInTheDocument();
    expect(server.calls.some((entry) => entry.path.endsWith("/ack"))).toBe(false);
  });

  it("falls back to the toast when the native bridge cannot deliver", async () => {
    const item = action({ text: "Pay the invoice", due: { date: "2026-11-12" } });
    const server = fakeServer([item], { reminders: [reminder({ actionIds: [item.id] })] });
    vi.stubGlobal("fetch", server.fetchMock);
    window.folio = { reminders: { deliversNatively: async () => false, onFocusAction: () => () => undefined } };
    renderHome();
    expect(await screen.findByText("Reminder")).toBeInTheDocument();
  });
});

describe("clear everything from a note", () => {
  const anchor = { noteId: "/notes/call.md", from: 0, to: 4, quote: "Send", orphaned: false };

  it("lets go of the note's open items in one step, with a single undo", async () => {
    const a = action({ text: "Send the budget", anchor });
    const b = action({ text: "Book the room", anchor });
    const elsewhere = action({ text: "Unrelated" });
    const server = fakeServer([a, b, elsewhere]);
    vi.stubGlobal("fetch", server.fetchMock);
    renderHome();
    await screen.findByText("Send the budget");
    fireEvent.click(within(cardOf("Send the budget")).getByRole("button", { name: "Clear actions from this note" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ path: "/api/actions/clear-note", body: { noteId: "/notes/call.md" } });
    expect(await screen.findByText(/Let go of 2 items from Call notes/)).toBeInTheDocument();
    expect(screen.queryByText("Send the budget")).not.toBeInTheDocument();
    expect(screen.queryByText("Book the room")).not.toBeInTheDocument();
    expect(screen.getByText("Unrelated")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ path: "/api/actions/undo-batch", body: { ids: [a.id, b.id] } }));
    expect(await screen.findByText("Send the budget")).toBeInTheDocument();
  });
});
