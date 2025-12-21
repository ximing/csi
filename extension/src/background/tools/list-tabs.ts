/**
 * list_tabs (protocol §4.15): list the tabs owned by this session
 * (`_tabIds`, falling back to `_tabId`), with group titles.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';

/**
 * Session tab ids from the daemon-injected fields (§3.4). Both fields are
 * always injected: an empty `_tabIds` and `_tabId: 0` both mean the session
 * owns no tabs (0 is never a valid Chrome tabId).
 */
export function sessionTabIds(args: ToolArgs): number[] {
  if (Array.isArray(args._tabIds) && args._tabIds.length > 0) {
    return args._tabIds.filter((id) => id !== 0);
  }
  const tabId = args._tabId;
  return tabId == null || tabId === 0 ? [] : [tabId];
}

export class ListTabsTool implements Tool {
  readonly name = 'list_tabs';

  async execute(args: ToolArgs): Promise<unknown> {
    const tabIds = sessionTabIds(args);
    if (tabIds.length === 0) return { success: true, tabs: [] };

    const tabs: unknown[] = [];
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        let groupTitle: string | undefined;
        if (tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          try {
            groupTitle = (await chrome.tabGroups.get(tab.groupId)).title;
          } catch {
            // group gone — omit title
          }
        }
        tabs.push({
          tabId: tab.id,
          url: tab.url ?? '',
          title: tab.title ?? '',
          active: tab.active,
          groupTitle,
        });
      } catch {
        // tab already closed — skip
      }
    }
    return { success: true, tabs };
  }
}
