/**
 * close_tab (protocol §4): close the session's current *owned* tab.
 * closed:false carries a machine-readable code (§3.4) — not_owned /
 * already_closed / close_failed; the daemon reconciles on code only.
 *
 * tabs.remove 不走 per-tab 队列，理由见 close-session.ts 头注：排在其它
 * session 的长任务后面会撞 daemon 120s 超时（假失败 + 迟到的副作用）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';
import { isOwnedTab, sessionTabIds } from '../session-tabs';
import { cleanupTabState, cleanupTabStateIfGone } from './close-cleanup';

export class CloseTabTool implements Tool {
  readonly name = 'close_tab';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const tabId = args._tabId;
    if (tabId == null || tabId === 0) {
      return { success: true, closed: false, code: 'not_owned', reason: 'session has no tab' };
    }
    if (!isOwnedTab(args, tabId)) {
      return {
        success: true,
        closed: false,
        code: 'not_owned',
        reason: 'borrowed target is not owned by this session',
      };
    }

    // Best-effort：内部已吞错，永不 reject，也绝不掩盖 remove 的真实结果。
    await ungroupClosedTabs([tabId], sessionTabIds(args));

    // tab 确认不在了才清 per-tab 状态；close_failed 时 tab 仍在，refs/queue 保留
    // （不变量见 close-cleanup.ts，与 close_session 共用）。
    try {
      await chrome.tabs.remove(tabId);
      cleanupTabState(tabId);
      return { success: true, closed: true };
    } catch (err) {
      // remove 拒绝分两种：tab 已不在（already_closed，daemon 对账移除）
      // 与瞬时失败 tab 仍在（close_failed，daemon 不得 forget）。
      if (await cleanupTabStateIfGone(tabId)) {
        return { success: true, closed: false, code: 'already_closed', reason: 'tab already closed' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: true,
        closed: false,
        code: 'close_failed',
        reason: `failed to close tab: ${message}`,
      };
    }
  }
}
