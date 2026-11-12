import type { TabGroup } from "../../../domain/types.ts";
import { filedDraftContent, isUntitledId } from "../../../lib/workspace.ts";

/** Home is a tab in the strip but never a note, draft or file. */
export const HOME_TAB_ID = "home";

export const isHomeTabId = (id: string | null | undefined): id is typeof HOME_TAB_ID => id === HOME_TAB_ID;

/** Show Home in a group, reusing an existing Home tab wherever it already lives. */
export function openHomeTab(
  groups: TabGroup[],
  groupId: string,
): { groups: TabGroup[]; groupId: string } {
  const existing = groups.find((group) => group.tabs.includes(HOME_TAB_ID));
  const targetId = existing?.id ?? groupId;
  return {
    groupId: targetId,
    groups: groups.map((group) =>
      group.id !== targetId
        ? group
        : {
            ...group,
            tabs: group.tabs.includes(HOME_TAB_ID) ? group.tabs : [HOME_TAB_ID, ...group.tabs],
            activeId: HOME_TAB_ID,
          },
    ),
  };
}

/**
 * Restoring a session never lands on Home when a draft was left unfinished.
 * Only a session that would otherwise show Home (or nothing) is redirected.
 */
export function preferUnfinishedDraft(
  state: { groups: TabGroup[]; activeGroupId: string },
  draftContent: (id: string) => string | undefined,
): { groups: TabGroup[]; activeGroupId: string } {
  const active = state.groups.find((group) => group.id === state.activeGroupId);
  if (active?.activeId && !isHomeTabId(active.activeId)) return state;
  const unfinished = (id: string) =>
    isUntitledId(id) && filedDraftContent(draftContent(id) ?? "").trim().length > 0;
  const owner = [active, ...state.groups].find((group) => group?.tabs.some(unfinished));
  const draftId = owner?.tabs.find(unfinished);
  if (!owner || !draftId) return state;
  return {
    activeGroupId: owner.id,
    groups: state.groups.map((group) => (group.id === owner.id ? { ...group, activeId: draftId } : group)),
  };
}
