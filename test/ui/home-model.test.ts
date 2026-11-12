import { describe, expect, it } from "vitest";
import type { ActionItem, TabGroup } from "../../src/domain/types.ts";
import { applyOptimistic, toastLabel } from "../../src/features/home/model/action-mutations.ts";
import { homeMayTakeFocus } from "../../src/features/home/model/focus-rules.ts";
import { groupHomeActions, isHomeEmpty } from "../../src/features/home/model/home-sections.ts";
import { HOME_TAB_ID, openHomeTab, preferUnfinishedDraft } from "../../src/features/home/model/home-tab.ts";
import { addDays, daysBetween, localDate, zonedTimeToInstant } from "../../src/features/home/model/home-time.ts";
import { snoozePresets } from "../../src/features/home/model/snooze-presets.ts";
import { triageCommand } from "../../src/features/home/model/triage-keys.ts";

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

const ids = (entries: { action: ActionItem }[]) => entries.map((entry) => entry.action.id);

describe("home sections", () => {
  it("puts overdue and due-today items in Now, calmly worded", () => {
    const overdue = action({ id: "overdue", due: { date: "2026-11-10" } });
    const today = action({ id: "today", due: { date: "2026-11-12", time: "14:00" } });
    const old = action({ id: "old", due: { date: "2026-10-03" } });
    const sections = groupHomeActions([today, overdue, old], NOW, "UTC");

    expect(ids(sections.now)).toEqual(["old", "overdue", "today"]);
    expect(sections.now[1].dueLabel).toBe("From Tuesday");
    expect(sections.now[0].dueLabel).toBe("From 3 Oct");
    expect(sections.now[2].dueLabel).toBe("Today 14:00");
    for (const entry of sections.now) expect(entry.dueLabel).not.toMatch(/overdue|late/i);
  });

  it("groups coming up by week and day, with windows shown by their start", () => {
    const friday = action({ id: "fri", due: { date: "2026-11-13" } });
    const sunday = action({ id: "sun", due: { date: "2026-11-15" } });
    const monday = action({ id: "mon", due: { date: "2026-11-16" } });
    const windowNextWeek = action({ id: "win", due: { window: { start: "2026-11-17", end: "2026-11-20" } } });
    const ongoing = action({ id: "ongoing", due: { window: { start: "2026-11-09", end: "2026-11-15" } } });
    const later = action({ id: "later", due: { date: "2026-12-24" } });
    const sections = groupHomeActions([later, windowNextWeek, monday, sunday, friday, ongoing], NOW, "UTC");

    expect(sections.now).toHaveLength(0);
    expect(sections.comingUp.map((week) => week.key)).toEqual(["this-week", "next-week", "later"]);
    const [thisWeek, nextWeek, laterWeek] = sections.comingUp;
    expect(thisWeek.days.map((day) => [day.key, ids(day.entries)])).toEqual([
      ["ongoing", ["ongoing"]],
      ["2026-11-13", ["fri"]],
      ["2026-11-15", ["sun"]],
    ]);
    expect(thisWeek.days[0].label).toBe("Anytime this week");
    expect(thisWeek.days[1].label).toBe("Tomorrow");
    expect(nextWeek.days.map((day) => [day.label, ids(day.entries)])).toEqual([
      ["Monday", ["mon"]],
      ["Tuesday", ["win"]],
    ]);
    expect(ids(laterWeek.days[0].entries)).toEqual(["later"]);
  });

  it("lists waiting-on items with how long they have waited and never as overdue", () => {
    const waiting = action({
      id: "w",
      kind: "waiting-on",
      person: "Ola",
      createdAt: "2026-11-09T09:00:00Z",
      due: { date: "2026-11-01" },
    });
    const sections = groupHomeActions([waiting], NOW, "UTC");
    expect(sections.now).toHaveLength(0);
    expect(sections.waiting[0].waitingLabel).toBe("since 3 days");
    expect(groupHomeActions([{ ...waiting, createdAt: "2026-11-12T01:00:00Z" }], NOW, "UTC").waiting[0].waitingLabel).toBe("since today");
    expect(groupHomeActions([{ ...waiting, createdAt: "2026-11-11T01:00:00Z" }], NOW, "UTC").waiting[0].waitingLabel).toBe("since yesterday");
    expect(groupHomeActions([{ ...waiting, createdAt: "2026-10-20T01:00:00Z" }], NOW, "UTC").waiting[0].waitingLabel).toBe("since 3 weeks");
  });

  it("keeps dateless open items as loose ends, suggestions to confirm, and faded ones apart", () => {
    const loose = action({ id: "loose" });
    const suggested = action({ id: "s", status: "suggested", origin: "suggested" });
    const faded = action({ id: "f", status: "faded" });
    const closed = [action({ status: "done" }), action({ status: "let-go" }), action({ status: "rejected" })];
    const sections = groupHomeActions([loose, suggested, faded, ...closed], NOW, "UTC");
    expect(ids(sections.looseEnds)).toEqual(["loose"]);
    expect(ids(sections.toConfirm)).toEqual(["s"]);
    expect(ids(sections.faded)).toEqual(["f"]);
    expect(sections.now).toHaveLength(0);
  });

  it("brings a lapsed snooze back into Now and hides a future one", () => {
    const lapsedRaw = action({ id: "raw", status: "snoozed", snoozedUntil: "2026-11-12T08:00:00Z", due: { date: "2026-12-01" } });
    const lapsedPresented = action({
      id: "presented",
      status: "open",
      history: [{ at: "2026-11-11T08:00:00Z", from: "open", to: "snoozed", by: "user" }],
    });
    const future = action({ id: "future", status: "snoozed", snoozedUntil: "2026-11-13T09:00:00Z" });
    const reopened = action({
      id: "reopened",
      history: [
        { at: "2026-11-11T08:00:00Z", from: "open", to: "snoozed", by: "user" },
        { at: "2026-11-11T09:00:00Z", from: "snoozed", to: "open", by: "user" },
      ],
    });
    const sections = groupHomeActions([lapsedRaw, lapsedPresented, future, reopened], NOW, "UTC");
    expect(ids(sections.now).sort()).toEqual(["presented", "raw"]);
    expect(sections.now.every((entry) => entry.reminder)).toBe(true);
    expect(ids(sections.looseEnds)).toEqual(["reopened"]);
    expect([...sections.now, ...sections.looseEnds].some((entry) => entry.action.id === "future")).toBe(false);
  });

  it("marks recent untouched auto-added items", () => {
    const recent = action({ id: "recent", origin: "auto", createdAt: "2026-11-12T06:00:00Z" });
    const stale = action({ id: "stale", origin: "auto", createdAt: "2026-11-08T06:00:00Z" });
    const touched = action({
      id: "touched",
      origin: "auto",
      createdAt: "2026-11-12T06:00:00Z",
      history: [{ at: "2026-11-12T07:00:00Z", from: "open", to: "snoozed", by: "user" }],
    });
    const manual = action({ id: "manual", createdAt: "2026-11-12T06:00:00Z" });
    const flags = Object.fromEntries(
      groupHomeActions([recent, stale, touched, manual], NOW, "UTC").looseEnds.map((e) => [e.action.id, e.recentlyAdded]),
    );
    expect(flags).toEqual({ recent: true, stale: false, manual: false });
  });

  it("follows the user's timezone for what today means", () => {
    // 12 Nov 21:00 UTC is already Friday 13 Nov in Auckland and still Thursday in Los Angeles.
    const lateEvening = new Date("2026-11-12T21:00:00Z");
    const thursday = action({ id: "thu", due: { date: "2026-11-12" } });
    const friday = action({ id: "fri", due: { date: "2026-11-13" } });
    const auckland = groupHomeActions([thursday, friday], lateEvening, "Pacific/Auckland");
    expect(ids(auckland.now)).toEqual(["thu", "fri"]);
    expect(auckland.now[0].dueLabel).toBe("From yesterday");
    expect(auckland.now[1].dueLabel).toBe("Today");
    const la = groupHomeActions([thursday, friday], lateEvening, "America/Los_Angeles");
    expect(ids(la.now)).toEqual(["thu"]);
    expect(la.comingUp[0].days[0].label).toBe("Tomorrow");
  });

  it("treats everything but faded items as the empty state", () => {
    expect(isHomeEmpty(groupHomeActions([], NOW, "UTC"))).toBe(true);
    expect(isHomeEmpty(groupHomeActions([action({ status: "faded" })], NOW, "UTC"))).toBe(true);
    expect(isHomeEmpty(groupHomeActions([action()], NOW, "UTC"))).toBe(false);
  });
});

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

  it("maps triage keys and ignores modified keys", () => {
    const key = (value: string, extra = {}) => triageCommand({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...extra });
    expect(key("j")).toBe("next");
    expect(key("ArrowUp")).toBe("previous");
    expect(key("a")).toBe("accept");
    expect(key("e")).toBe("edit");
    expect(key("s")).toBe("snooze");
    expect(key("x")).toBe("not-an-action");
    expect(key("n")).toBe("not-important");
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("a", { ctrlKey: true })).toBeNull();
    expect(key("q")).toBeNull();
  });
});
