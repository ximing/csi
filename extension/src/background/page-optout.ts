/**
 * 页面 opt-out（协议 §4.7）：顶层 document 声明
 * `<meta name="csi" content="disallow">` 时，CSI 拒绝对该 tab 执行
 * tab-aimed 工具。判定是工具执行前的确定性程序检查；页面脚本事后
 * 增删 meta 的 TOCTOU 是已接受的风险（声明式协议，同 robots.txt）。
 */
import { sendCommand } from './debugger-session';
import { currentEpoch } from './refs';
import { ToolError } from './tool-error';

/** 命中时的统一文案：明确告知 Agent 该站点拒绝自动化操作，勿再重试本页。 */
export function pageOptOutError(toolName: string): ToolError {
  return new ToolError(
    `${toolName}: this page opted out of agent operation ` +
      `(meta name="csi" content="disallow"); CSI will not act on this site`,
    'page_opt_out',
  );
}

export function isPageOptOutError(err: unknown): boolean {
  return err instanceof ToolError && err.code === 'page_opt_out';
}

/**
 * 在目标页执行的探针。返回 `{ready, optOut}`：`ready` 为
 * `document.readyState !== 'loading'`。导出给单测直接 eval，避免 stub
 * 返回值与真实 selector/匹配语义脱节。
 */
export const PAGE_OPT_OUT_PROBE =
  `(function(){` +
  `const ready = document.readyState !== 'loading';` +
  `const metas = document.querySelectorAll('meta[name="csi" i]');` +
  `let optOut = false;` +
  `for (const m of metas) {` +
  `if ((m.getAttribute('content') || '').trim().toLowerCase() === 'disallow') { optOut = true; break; }` +
  `}` +
  `return {ready, optOut};` +
  `})()`;

const cache = new Map<number, { epoch: number; optOut: boolean }>();

type ProbeCdp = {
  exceptionDetails?: unknown;
  result?: { value?: unknown };
};

function parseProbe(res: ProbeCdp | undefined): { ready: boolean; optOut: boolean } | null {
  if (!res || res.exceptionDetails) return null;
  const v = res.result?.value;
  if (!v || typeof v !== 'object') return null;
  const ready = (v as { ready?: unknown }).ready;
  const optOut = (v as { optOut?: unknown }).optOut;
  if (typeof ready !== 'boolean' || typeof optOut !== 'boolean') return null;
  return { ready, optOut };
}

/** 顶层 document 是否声明 opt-out。epoch 与 tab URL 都没变时只评估一次（协议 §4.7）。 */
export async function pageOptOut(tabId: number): Promise<boolean> {
  const epoch = currentEpoch(tabId);
  const hit = cache.get(tabId);
  if (hit && hit.epoch === epoch) return hit.optOut;
  let res: ProbeCdp | undefined;
  try {
    res = await sendCommand<ProbeCdp>(tabId, 'Runtime.evaluate', {
      expression: PAGE_OPT_OUT_PROBE,
      returnByValue: true,
    });
  } catch (err) {
    // 命令被拒绝且 tab 还在：与 exceptionDetails 一样，本次当未声明、不写缓存。
    // tab 已经没了则把原错误抛回去，调用方归类 stale_target——
    // 当成未声明会让 navigate 成功收养一个死 tab。
    try {
      await chrome.tabs.get(tabId);
    } catch {
      throw err;
    }
    return false;
  }
  const parsed = parseProbe(res);
  // 失败 / 形状非法：本次当未声明，不写缓存，下次再探。
  if (!parsed) return false;
  if (parsed.optOut) {
    cache.set(tabId, { epoch, optOut: true });
    return true;
  }
  // loading 中的否定会把尚未 parse 的 <head> 锁成「允许」一整 epoch。
  if (!parsed.ready) return false;
  cache.set(tabId, { epoch, optOut: false });
  return false;
}

/** tab-aimed 工具执行前断言；命中抛 page_opt_out（协议 §2.1 错误表）。 */
export async function assertPageAllowed(tabId: number, toolName: string): Promise<void> {
  if (await pageOptOut(tabId)) throw pageOptOutError(toolName);
}

export function forgetPageOptOut(tabId: number): void {
  cache.delete(tabId);
}

// 兜底自清：与 refs.ts 同款——tab 关闭后回收缓存，防死 tab 状态泄漏到 SW 重启。
chrome.tabs.onRemoved.addListener((tabId) => forgetPageOptOut(tabId));

// 主帧 Page.frameNavigated 在 MV3 里会丢。URL 一变就丢掉 opt-out 缓存，
// 避免上一页的「允许」在 epoch 没涨时继续放行。refs 仍只跟 epoch。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) forgetPageOptOut(tabId);
});
