/**
 * close_session (protocol §4.20): close every *owned* tab. Never closes a
 * borrowed user tab, even if it is the current target.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';
import { sessionTabIds } from '../session-tabs';
import { enqueueTab, dropTabQueue } from '../tab-queue';
import { deleteTargetState } from '../refs';

export class CloseSessionTool implements Tool {
  readonly name = 'close_session';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const tabIds = sessionTabIds(args);
    if (tabIds.length === 0) return { success: true, closed: 0 };

    await ungroupClosedTabs(tabIds, tabIds);

    const results = await Promise.all(
      tabIds.map(async (id) => {
        try {
          await chrome.tabs.get(id);
        } catch {
          dropTabQueue(id);
          deleteTargetState(id);
          return 0;
        }
        return enqueueTab(id, async () => {
          try {
            await chrome.tabs.remove(id);
            return 1;
          } catch {
            return 0;
          } finally {
            dropTabQueue(id);
            deleteTargetState(id);
          }
        });
      }),
    );
    const closed = results.reduce<number>((a, b) => a + b, 0);
    return { success: true, closed };
  }
}
