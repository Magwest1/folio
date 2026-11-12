import { describe, expect, it } from "vitest";
import type { ActionItem, TabGroup } from "../../src/domain/types.ts";
import { applyOptimistic, toastLabel } from "../../src/features/home/model/action-mutations.ts";
import { homeMayTakeFocus } from "../../src/features/home/model/focus-rules.ts";
import { HOME_TAB_ID, openHomeTab, preferUnfinishedDraft } from "../../src/features/home/model/home-tab.ts";
import { addDays, daysBetween, localDate, zonedTimeToInstant } from "../../src/features/home/model/home-time.ts";
import { snoozePresets } from "../../src/features/home/model/snooze-presets.ts";
import { boardCommand } from "../../src/features/home/model/triage-keys.ts";

// Thursday 12 November 2026.
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

describe("home time helpers", () => {
  it("computes dates and instants on the wall clock", () => {
    expect(localDate(NOW, "UTC")).toBe("2026-11-12");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(daysBetween("2026-11-12", "2026-11-09")).toBe(-3);
    expect(zonedTimeToInstant("2026-11-13", 9, 0, "Europe/Oslo").toISOString()).toBe("2026-11-13T08:00:00.000Z");
    // Across the autumn clock change, 9:00 in Oslo moves from UTC+2 to UTC+1.
    expect(zonedTimeToInstant("2026-10-25", 9, 0, "Europe/Oslo").toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(zonedTimeToInstant("2026-10-24", 9, 0, "Europe/Oslo").toISOString()).toBe("2026-10-24T07:00:00.000Z");
  });
});

describe("snooze presets", () => {
  it("offers later today, tomorrow morning and next week in the user's timezone", () => {
    const presets = snoozePresets(new Date("2026-11-12T10:00:00Z"), "Europe/Oslo");
    expect(presets.map((preset) => [preset.id, preset.until])).toEqual([
      ["later-today", "2026-11-12T13:00:00.000Z"],
      ["tomorrow-morning", "2026-11-13T08:00:00.000Z"],
      ["next-week", "2026-11-16T08:00:00.000Z"],
    ]);
  });

  it("caps later today in the evening and drops it at night", () => {
    const evening = snoozePresets(new Date("2026-11-12T19:00:00Z"), "UTC");
    expect(evening[0]).toMatchObject({ id: "later-today", until: "2026-11-12T21:00:00.000Z" });
    const night = snoozePresets(new Date("2026-11-12T22:30:00Z"), "UTC");
    expect(night.map((preset) => preset.id)).toEqual(["tomorrow-morning", "next-week"]);
  });

  it("moves next week to the following Monday, even on a Monday or Sunday", () => {
    expect(snoozePresets(new Date("2026-11-16T10:00:00Z"), "UTC").at(-1)?.until).toBe("2026-11-23T09:00:00.000Z");
    expect(snoozePresets(new Date("2026-11-15T10:00:00Z"), "UTC").at(-1)?.until).toBe("2026-11-16T09:00:00.000Z");
  });

  it("uses the local date, not the UTC date, for tomorrow", () => {
    const presets = snoozePresets(new Date("2026-11-12T21:00:00Z"), "Pacific/Auckland");
    expect(presets.find((preset) => preset.id === "tomorrow-morning")?.until).toBe("2026-11-13T20:00:00.000Z");
  });
});

describe("optimistic changes", () => {
  it("moves the card out of the active statuses and records the step", () => {
    const base = action();
    expect(applyOptimistic(base, { type: "not-important" }, NOW)).toMatchObject({ status: "let-go", snoozedUntil: null });
    expect(applyOptimistic(base, { type: "done" }, NOW).status).toBe("done");
    expect(applyOptimistic({ ...base, status: "suggested" }, { type: "accept" }, NOW).status).toBe("open");
    const snoozed = applyOptimistic(base, { type: "snooze", until: "2026-11-13T08:00:00Z", label: "Tomorrow morning" }, NOW);
    expect(snoozed).toMatchObject({ status: "snoozed", snoozedUntil: "2026-11-13T08:00:00Z" });
    expect(snoozed.history.at(-1)).toMatchObject({ from: "open", to: "snoozed" });
    expect(applyOptimistic(base, { type: "edit", patch: { text: "New" } }, NOW)).toMatchObject({ text: "New", editedByUser: true });
  });

  it("words the undo toasts kindly", () => {
    expect(toastLabel({ type: "not-important" })).toBe("Let go. It won't come back.");
    expect(toastLabel({ type: "snooze", until: "x", label: "Tomorrow morning" })).toBe("Snoozed until tomorrow morning.");
  });
});

describe("home tab model", () => {
  const group = (id: "primary" | "secondary", tabs: string[], activeId: string | null): TabGroup => ({ id, tabs, activeId, previewId: null });

  it("opens Home once, in the group where it already lives", () => {
    const groups = [group("primary", ["/a.md"], "/a.md"), group("secondary", [HOME_TAB_ID, "/b.md"], "/b.md")];
    const opened = openHomeTab(groups, "primary");
    expect(opened.groupId).toBe("secondary");
    expect(opened.groups[1].activeId).toBe(HOME_TAB_ID);
    expect(opened.groups[0].tabs).toEqual(["/a.md"]);
    const fresh = openHomeTab([group("primary", ["/a.md"], "/a.md")], "primary");
    expect(fresh.groups[0]).toMatchObject({ tabs: [HOME_TAB_ID, "/a.md"], activeId: HOME_TAB_ID });
  });

  it("activates an unfinished draft instead of Home, but leaves other sessions alone", () => {
    const contents: Record<string, string> = { "untitled:1": "\nhalf a thought", "untitled:2": "\n   " };
    const lookup = (id: string) => contents[id];
    const onHome = { groups: [group("primary", [HOME_TAB_ID, "untitled:2", "untitled:1"], HOME_TAB_ID)], activeGroupId: "primary" };
    expect(preferUnfinishedDraft(onHome, lookup).groups[0].activeId).toBe("untitled:1");

    const onNote = { groups: [group("primary", ["/a.md", "untitled:1"], "/a.md")], activeGroupId: "primary" };
    expect(preferUnfinishedDraft(onNote, lookup)).toBe(onNote);

    const blankOnly = { groups: [group("primary", [HOME_TAB_ID, "untitled:2"], HOME_TAB_ID)], activeGroupId: "primary" };
    expect(preferUnfinishedDraft(blankOnly, lookup)).toBe(blankOnly);

    const otherGroup = {
      groups: [group("primary", [HOME_TAB_ID], HOME_TAB_ID), group("secondary", ["untitled:1"], "untitled:1")],
      activeGroupId: "primary",
    };
    expect(preferUnfinishedDraft(otherGroup, lookup)).toMatchObject({ activeGroupId: "secondary" });
  });
});

describe("home focus and keys", () => {
  it("never takes focus from an editor or input", () => {
    const home = document.createElement("div");
    const editor = document.createElement("div");
    editor.className = "cm-content";
    const tabs = document.createElement("div");
    tabs.className = "editor-tabs";
    const tabButton = document.createElement("button");
    tabs.append(tabButton);
    document.body.append(home, editor, tabs);
    expect(homeMayTakeFocus(null, home)).toBe(true);
    expect(homeMayTakeFocus(document.body, home)).toBe(true);
    expect(homeMayTakeFocus(tabButton, home)).toBe(true);
    expect(homeMayTakeFocus(editor, home)).toBe(false);
    home.remove();
    editor.remove();
    tabs.remove();
  });

  it("maps board keys and ignores modified keys", () => {
    const key = (value: string, extra = {}) =>
      boardCommand({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
    expect(key("j")).toEqual({ type: "focus", direction: "next" });
    expect(key("ArrowUp")).toEqual({ type: "focus", direction: "previous" });
    expect(key("ArrowRight")).toBeNull();
    expect(key("a")).toEqual({ type: "accept" });
    expect(key("d")).toEqual({ type: "done" });
    expect(key("e")).toEqual({ type: "edit" });
    expect(key("s")).toEqual({ type: "snooze" });
    expect(key("x")).toEqual({ type: "not-an-action" });
    expect(key("n")).toEqual({ type: "not-important" });
    expect(key("Enter")).toEqual({ type: "open-source" });
    expect(key("ArrowUp", { shiftKey: true })).toEqual({ type: "move", to: "earlier" });
    expect(key("ArrowDown", { shiftKey: true })).toEqual({ type: "move", to: "later" });
    // Left and right stay as aliases for the previous and next bucket; End means no date.
    expect(key("ArrowLeft", { shiftKey: true })).toEqual({ type: "move", to: "earlier" });
    expect(key("ArrowRight", { shiftKey: true })).toEqual({ type: "move", to: "later" });
    expect(key("End", { shiftKey: true })).toEqual({ type: "move", to: "loose" });
    expect(key("n", { shiftKey: true })).toBeNull();
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("a", { ctrlKey: true })).toBeNull();
    expect(key("q")).toBeNull();
  });
});
