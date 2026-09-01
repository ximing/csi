/**
 * 「tab 已死亡」类错误的统一归类（协议 §3.3 的 stale_target）。
 *
 * Chrome 各 API 报 tab 不存在的文案不一（"No tab with id" / "No tab with
 * given id" / target closed），daemon 又只凭 ToolError.code == stale_target
 * 才 ForgetTab 清理 session 状态（协议 §3.4）。因此所有出口在把裸错往外抛
 * 之前，先用 chrome.tabs.get 探测：tab 确实没了就归一为 stale_target；
 * 探测而不用错误文案匹配，与现实对齐、不随 Chrome 版本漂移。
 */
import { ToolError } from './tool-error';

export function staleTargetError(tabId: number, session: string): ToolError {
  return new ToolError(`session target tab ${tabId} is no longer available`, 'stale_target', {
    tabId,
    session,
  });
}

/**
 * err 若是 tab 死亡导致 → 返回对应的 stale_target ToolError；否则返回 null
 * （已是 ToolError 的确定性业务错误原样放行；tab 仍在的瞬时错误走原有路径）。
 */
export async function asStaleTarget(
  tabId: number,
  session: string,
  err: unknown,
): Promise<ToolError | null> {
  if (err instanceof ToolError) return null;
  try {
    await chrome.tabs.get(tabId);
    return null;
  } catch {
    return staleTargetError(tabId, session);
  }
}
