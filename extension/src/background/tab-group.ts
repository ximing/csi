/**
 * Session tab grouping (protocol §3.4): tabs created by `navigate` for a
 * session are grouped under `agent:<session>` (or an explicit group_title),
 * with per-session colors.
 */

/** Well-known sessions keep a stable color. */
const FIXED_GROUP_COLORS: Record<string, chrome.tabGroups.ColorEnum> = {
  twitter: 'blue',
  xhs: 'red',
  zhihu: 'blue',
  worldquant: 'purple',
};

const ROTATION_COLORS: chrome.tabGroups.ColorEnum[] = [
  'green',
  'yellow',
  'cyan',
  'orange',
  'pink',
  'grey',
];

/** session -> tab group id (invalidated when the group disappears). */
const sessionGroupIds = new Map<string, number>();
/** session -> explicit group title remembered across navigations. */
const sessionGroupTitles = new Map<string, string>();
let rotationCounter = 0;

let groupRemovedListenerRegistered = false;

/** Forget session->group mappings when a group is removed by the user. */
export function ensureGroupRemovedListener(): void {
  if (groupRemovedListenerRegistered) return;
  groupRemovedListenerRegistered = true;
  chrome.tabGroups.onRemoved.addListener((group) => {
    for (const [session, groupId] of sessionGroupIds) {
      if (groupId === group.id) {
        sessionGroupIds.delete(session);
        break;
      }
    }
  });
}

/**
 * Before closing tabs, ungroup them — but only when the whole group belongs
 * to the session (so closing a session never strips user-owned tabs out of
 * a mixed group).
 */
export async function ungroupClosedTabs(closingTabIds: number[], sessionTabIds: number[]): Promise<void> {
  try {
    const sessionSet = new Set(sessionTabIds);
    const closingSet = new Set(closingTabIds);
    const tabs = await Promise.all(
      closingTabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
    );
    const groupIds = new Set<number>();
    for (const tab of tabs) {
      if (tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        groupIds.add(tab.groupId);
      }
    }
    for (const groupId of groupIds) {
      const groupTabs = await chrome.tabs.query({ groupId });
      const entirelySessionOwned = groupTabs.every(
        (t) => t.id != null && sessionSet.has(t.id),
      );
      if (!entirelySessionOwned) continue;
      const toUngroup = groupTabs
        .filter((t) => t.id != null && closingSet.has(t.id))
        .map((t) => t.id as number);
      if (toUngroup.length > 0) {
        await chrome.tabs.ungroup(toUngroup);
      }
    }
  } catch {
    // grouping is best-effort — never block tab closing
  }
}

/** Add a tab to (or create) the group for a session. Best-effort. */
export async function addToSessionGroup(
  tabId: number,
  session: string,
  groupTitle?: string,
): Promise<void> {
  try {
    const knownGroupId = sessionGroupIds.get(session);
    if (knownGroupId != null) {
      await chrome.tabs.group({ tabIds: tabId, groupId: knownGroupId });
      return;
    }

    const defaultTitle = `agent:${session}`;
    const existing = await chrome.tabGroups.query({ title: defaultTitle });
    if (existing.length > 0) {
      const groupId = existing[0]!.id;
      await chrome.tabs.group({ tabIds: tabId, groupId });
      sessionGroupIds.set(session, groupId);
      return;
    }

    if (groupTitle) sessionGroupTitles.set(session, groupTitle);
    const title = groupTitle ?? sessionGroupTitles.get(session) ?? defaultTitle;
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    const color =
      FIXED_GROUP_COLORS[session] ?? ROTATION_COLORS[rotationCounter++ % ROTATION_COLORS.length]!;
    await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
    sessionGroupIds.set(session, groupId);
  } catch {
    // grouping is best-effort — never fail a navigation over it
  }
}
