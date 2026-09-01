/**
 * list_tabs (protocol §4.18): list owned tabs (`_tabIds` only). Borrowed
 * current target is a separate `currentTarget` field.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { isOwnedTab, sessionTabIds } from '../session-tabs';

export { sessionTabIds };

export class ListTabsTool implements Tool {
  readonly name = 'list_tabs';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const tabIds = sessionTabIds(args);
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

    const currentId = args._tabId;
    const borrowedCurrent =
      currentId != null && currentId !== 0 && !isOwnedTab(args, currentId);
    if (!borrowedCurrent) {
      return { success: true, tabs };
    }

    let url = '';
    let title = '';
    try {
      const tab = await chrome.tabs.get(currentId);
      url = tab.url ?? '';
      title = tab.title ?? '';
    } catch {
      // still report the id
    }
    return {
      success: true,
      tabs,
      currentTarget: { tabId: currentId, borrowed: true, url, title },
    };
  }
}
