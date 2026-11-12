import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionSuppressions, ReminderSettings as Settings } from "../../src/domain/types.ts";
import { ReminderSettings } from "../../src/features/settings/components/ReminderSettings.tsx";
import { SettingsDialog } from "../../src/features/settings/components/SettingsDialog.tsx";

const DEFAULTS: Settings = {
  level: "gentle",
  quietHours: { enabled: true, start: "21:00", end: "08:00" },
  morningBrief: { enabled: false, time: "08:30" },
  stillRelevantAfterDays: 14,
  fadeAfterDays: 7,
};

function fakeServer(options: { suppressions?: ActionSuppressions; reject?: string } = {}) {
  let settings = structuredClone(DEFAULTS);
  let suppressions: ActionSuppressions = options.suppressions ?? { sources: [], kinds: [] };
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    if (url.pathname === "/api/reminders/settings") {
      if (method === "PUT") {
        if (options.reject) return json({ error: options.reject }, 400);
        settings = { ...settings, ...body, quietHours: { ...settings.quietHours, ...body.quietHours }, morningBrief: { ...settings.morningBrief, ...body.morningBrief } };
      }
      return json(settings);
    }
    if (url.pathname === "/api/actions/suppressions") {
      if (method === "POST") suppressions = body.kind ? { ...suppressions, kinds: [...suppressions.kinds, body.kind] } : { ...suppressions, sources: [...suppressions.sources, body.source] };
      if (method === "DELETE") suppressions = {
        kinds: suppressions.kinds.filter((kind) => kind !== url.searchParams.get("kind")),
        sources: suppressions.sources.filter((source) => source !== url.searchParams.get("source")),
      };
      return json(suppressions);
    }
    return json({ error: "unexpected" }, 404);
  });
  return { fetchMock, calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.folio;
});

describe("Reminders settings", () => {
  it("shows the saved settings as a calm segmented level, quiet hours and a morning brief", async () => {
    vi.stubGlobal("fetch", fakeServer().fetchMock);
    render(<ReminderSettings />);
    const levels = await screen.findByRole("radiogroup", { name: "Reminder level" });
    expect(within(levels).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["off", "gentle", "normal"]);
    expect(within(levels).getByRole("radio", { name: /Gentle/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Keep quiet hours" })).toBeChecked();
    expect(screen.getByLabelText("Quiet hours start")).toHaveValue("21:00");
    expect(screen.getByLabelText("Quiet hours end")).toHaveValue("08:00");
    expect(screen.getByRole("checkbox", { name: "Send a morning brief" })).not.toBeChecked();
    expect(screen.getByLabelText("Morning brief time")).toBeDisabled();
    expect(screen.getByLabelText(/Ask whether it's still relevant/)).toHaveValue(14);
    expect(screen.getByText("Nothing is left out.")).toBeInTheDocument();
  });

  it("saves each change as soon as it is made", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    render(<ReminderSettings />);
    await screen.findByRole("radiogroup", { name: "Reminder level" });

    fireEvent.click(screen.getByRole("radio", { name: /Normal/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Normal/ })).toBeChecked());
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep quiet hours" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Keep quiet hours" })).not.toBeChecked());
    fireEvent.click(screen.getByRole("checkbox", { name: "Send a morning brief" }));
    await waitFor(() => expect(screen.getByLabelText("Morning brief time")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Morning brief time"), { target: { value: "07:45" } });
    const days = screen.getByLabelText(/Ask whether it's still relevant/);
    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.blur(days);

    await waitFor(() => expect(server.writes()).toHaveLength(5));
    expect(server.writes().map((call) => call.body)).toEqual([
      { level: "normal" },
      { quietHours: { enabled: false } },
      { morningBrief: { enabled: true } },
      { morningBrief: { time: "07:45" } },
      { stillRelevantAfterDays: 30 },
    ]);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("mutes kinds with the store's mute API and lets excluded sources back in", async () => {
    const server = fakeServer({ suppressions: { kinds: ["event"], sources: ["/archive/", "/notes/private.md"] } });
    vi.stubGlobal("fetch", server.fetchMock);
    render(<ReminderSettings />);
    const events = await screen.findByRole("checkbox", { name: "Events" });
    expect(events).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Waiting on others" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Waiting on others" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Waiting on others" })).toBeChecked());
    fireEvent.click(events);
    await waitFor(() => expect(events).not.toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Include /archive/ again" }));
    await waitFor(() => expect(screen.queryByText("/archive/ (folder)")).not.toBeInTheDocument());
    expect(screen.getByText("/notes/private.md")).toBeInTheDocument();
    expect(server.writes()).toEqual([
      expect.objectContaining({ method: "POST", body: { kind: "waiting-on" } }),
      expect.objectContaining({ method: "DELETE", search: "?kind=event" }),
      expect.objectContaining({ method: "DELETE", search: "?source=%2Farchive%2F" }),
    ]);
  });

  it("says so plainly, and keeps the old value, when a change is refused", async () => {
    vi.stubGlobal("fetch", fakeServer({ reject: "Level must be one of off, gentle, normal." }).fetchMock);
    render(<ReminderSettings />);
    await screen.findByRole("radiogroup", { name: "Reminder level" });
    fireEvent.click(screen.getByRole("radio", { name: /Off/ }));
    expect(await screen.findByText("Level must be one of off, gentle, normal.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Gentle/ })).toBeChecked();
  });

  it("is a category of the Settings dialog", async () => {
    vi.stubGlobal("fetch", fakeServer().fetchMock);
    render(
      <SettingsDialog
        themeId="original"
        onSelectTheme={() => {}}
        obsidianImport={{ supported: false, busy: false, scan: null, job: null, error: "", selectVault: () => {}, confirmImport: () => {}, cancelImport: () => {}, clearScan: () => {} }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    expect(screen.getByRole("region", { name: "Reminders settings" })).toBeInTheDocument();
    expect(await screen.findByRole("radiogroup", { name: "Reminder level" })).toBeInTheDocument();
  });
});
