/**
 * close_session (protocol §4.17): close every tab owned by this session.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';
import { sessionTabIds } from './list-tabs';

export class CloseSessionTool implements Tool {
  readonly name = 'close_session';

  async execute(args: ToolArgs): Promise<unknown> {
    const tabIds = sessionTabIds(args);
    if (tabIds.length === 0) return { success: true, closed: 0 };

    await ungroupClosedTabs(tabIds, tabIds);

    let closed = 0;
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closed++;
      } catch {
        // tab already closed — keep going
      }
    }
    return { success: true, closed };
  }
}
