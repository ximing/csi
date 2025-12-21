/**
 * close_tab (protocol §4.16): close the session's current tab (`_tabId`).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';

export class CloseTabTool implements Tool {
  readonly name = 'close_tab';

  async execute(args: ToolArgs): Promise<unknown> {
    // `_tabId` is always injected; 0 means the session has no tab.
    const tabId = args._tabId;
    if (tabId == null || tabId === 0) {
      return { success: true, closed: false, reason: 'session has no tab' };
    }

    const sessionTabIds = Array.isArray(args._tabIds) ? args._tabIds : [tabId];
    await ungroupClosedTabs([tabId], sessionTabIds);

    try {
      await chrome.tabs.remove(tabId);
      return { success: true, closed: true };
    } catch {
      return { success: true, closed: false, reason: 'tab already closed' };
    }
  }
}
