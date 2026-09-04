/**
 * close_session (protocol §4): close every *owned* tab. Never closes a
 * borrowed user tab, even if it is the current target.
 *
 * tabs.remove 不走 per-tab 队列：它不是页面态操作，per-tab 队列只为串行化
 * 共享 tab 上的 CDP/页面操作（§3.4）。排在其它 session 的长任务（wait 上限
 * 120s）后面会撞 daemon CallTool 120s 超时——客户端被告知失败、remove 稍后
 * 照跑（假失败 + 迟到的副作用）；被抢占的在飞任务因 tab 消失按既有 detach/
 * stale 路径报错，语义同样正确。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ungroupClosedTabs } from '../tab-group';
import { sessionTabIds } from '../session-tabs';
import { cleanupTabState, cleanupTabStateIfGone } from './close-cleanup';

export class CloseSessionTool implements Tool {
  readonly name = 'close_session';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const tabIds = sessionTabIds(args);
    if (tabIds.length === 0) return { success: true, closed: 0 };

    await ungroupClosedTabs(tabIds, tabIds);

    const results = await Promise.all(
      tabIds.map(async (id) => {
        try {
          await chrome.tabs.remove(id);
          cleanupTabState(id);
          return 1;
        } catch {
          // 与 close_tab 同语义（§3.4）：remove 失败先探测。tab 仍在是瞬时失败，
          // 不得清 refs/queue——活 tab 的队列尾被删会让在飞任务与新任务并发跑
          // 同一 tab；tab 已不在才按已关闭清理（不变量见 close-cleanup.ts）。
          await cleanupTabStateIfGone(id);
          return 0;
        }
      }),
    );
    const closed = results.reduce<number>((a, b) => a + b, 0);
    return { success: true, closed };
  }
}
