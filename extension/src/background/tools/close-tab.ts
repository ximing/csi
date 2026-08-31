/**
 * close_tab (protocol §4.19): close the session's current *owned* tab.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';
import { isOwnedTab, sessionTabIds } from '../session-tabs';
import { enqueueTab, dropTabQueue } from '../tab-queue';
import { deleteTargetState } from '../refs';

export class CloseTabTool implements Tool {
  readonly name = 'close_tab';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const tabId = args._tabId;
    if (tabId == null || tabId === 0) {
      return { success: true, closed: false, reason: 'session has no tab' };
    }
    if (!isOwnedTab(args, tabId)) {
      return {
        success: true,
        closed: false,
        reason: 'borrowed target is not owned by this session',
      };
    }

    return enqueueTab(tabId, async () => {
      try {
        await ungroupClosedTabs([tabId], sessionTabIds(args));
        await chrome.tabs.remove(tabId);
        return { success: true, closed: true };
      } catch {
        return { success: true, closed: false, reason: 'tab already closed' };
      } finally {
        dropTabQueue(tabId);
        deleteTargetState(tabId);
      }
    });
  }
}
