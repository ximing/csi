/**
 * close_tab / close_session 共用的 per-tab 状态清理（queue + @e refs）。
 * 不变量只有一条，两处共用：tab 确认不在了才清；瞬时失败（tab 仍在）绝不
 * 清——活 tab 的队列尾被删会让在飞任务与新任务并发跑同一 tab。
 */
import { dropTabQueue } from '../tab-queue';
import { deleteTargetState } from '../refs';

/** tab 已确认移除（remove 成功）后的直接清理。 */
export function cleanupTabState(tabId: number): void {
  dropTabQueue(tabId);
  deleteTargetState(tabId);
}

/**
 * remove 失败后探测：tab 真不在了才清理（返回 true，调用方按 already_closed
 * 上报）；tab 仍在是瞬时失败，refs/queue 保留。
 */
export async function cleanupTabStateIfGone(tabId: number): Promise<boolean> {
  const gone = await chrome.tabs.get(tabId).then(
    () => false,
    () => true,
  );
  if (gone) cleanupTabState(tabId);
  return gone;
}
