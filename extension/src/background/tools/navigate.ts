/**
 * navigate (protocol §4): open a URL. Reuses an *owned* current tab only.
 * Borrowed current targets always get a new owned tab (协议 §3.4).
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { addToSessionGroup } from '../tab-group';
import { enqueueTab } from '../tab-queue';
import { sessionTabIds } from '../session-tabs';
import { bumpEpoch } from '../refs';
import { asStaleTarget, staleTargetError } from '../stale-target';

const LOAD_TIMEOUT_MS = 30_000;

/** Chrome 会给裸域补尾斜杠（https://host ↔ https://host/）；路径尾斜杠不是这种规范化。 */
function samePageUrl(actual: string, requested: string): boolean {
  if (actual === requested) return true;
  const bareOrigin = (u: string) => /^https?:\/\/[^/?#]+\/?$/i.test(u);
  if (!bareOrigin(actual) || !bareOrigin(requested)) return false;
  return actual.replace(/\/$/, '') === requested.replace(/\/$/, '');
}

interface WaitForLoadOptions {
  /**
   * 导航前 tab 的旧 url（Page.navigate 路径）：探测/事件按「url 已偏离旧值」
   * 判定本次导航落地——对 redirect（终态 url ≠ 请求 url）和 Chrome 的裸域
   * 补斜杠规范化（同文档锚点导航只发 url-only 事件，没有 complete）都健壮。
   * 不传（新建 tab）：任何非空 complete 都是本次加载。
   */
  prevUrl?: string;
  /**
   * reload 路径：url 不变，无法靠 url 区分新旧 complete。要求先观察到
   * reload 后的 loading 事件才接受随后的 complete——否则仍在途的旧加载的
   * complete 会把 waitForLoad 提前 resolve（reload 才刚开始）。
   */
  requireLoading?: boolean;
}

interface LoadWait {
  promise: Promise<void>;
  /** 放弃等待（如 Page.reload 发送失败）：清监听器/定时器，promise 永不 settle。 */
  cancel: () => void;
}

export class NavigateTool implements Tool {
  readonly name = 'navigate';

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const url = args.url as string | undefined;
    if (!url) throw new Error('navigate: url is required');

    const newTab = args.newTab === true;
    const session = args._session;
    const groupTitle = args.group_title as string | undefined;
    const owned = sessionTabIds(args);
    const currentId = args._tabId ?? 0;
    const sessionName = typeof args._session === 'string' ? args._session : 'default';

    let existing: chrome.tabs.Tab | undefined;
    if (currentId !== 0 && owned.includes(currentId)) {
      try {
        existing = await chrome.tabs.get(currentId);
      } catch {
        // owned 当前 tab 已死：无论 newTab 与否都报 stale_target（协议 §3.4），
        // daemon 只在这个分支 ForgetTab。若 newTab:true 放行继续新建，死 tabId
        // 会永远漂在 session 的 owned 集里（再没有路径探测它）；客户端收到
        // stale_target + nextTabId 后重试即可走完新建路径。
        throw staleTargetError(currentId, sessionName);
      }
    }

    const canReuse =
      !newTab &&
      existing != null &&
      !existing.url?.startsWith('chrome://') &&
      !existing.url?.startsWith('edge://');

    if (canReuse && existing?.id) {
      const tabId = existing.id;
      return enqueueTab(tabId, async () => {
        try {
          await ensureAttached(tabId);
          let frameId: string | undefined;
          // sameUrl 按任务执行时的当前 url 判定：排队期间页面可能已被并发导航，
          // 用过期 url 决定 reload vs navigate 会 reload 错误页面却返回请求的 url。
          const currentUrl = (await chrome.tabs.get(tabId)).url ?? '';
          const sameUrl = samePageUrl(currentUrl, url);
          if (sameUrl) {
            // reload 无法靠 url 区分新旧 complete → 事件驱动 + loading 门禁；
            // 先注册监听再发 reload，事件不丢。sendCommand 失败时 cancel 掉
            // 等待，不留悬空 promise / 监听器。
            const wait = this.waitForLoad(tabId, sessionName, { requireLoading: true });
            try {
              await sendCommand(tabId, 'Page.reload', { ignoreCache: true });
            } catch (err) {
              wait.cancel();
              throw err;
            }
            bumpEpoch(tabId, 'reload');
            await wait.promise;
          } else {
            const nav = await sendCommand<{ frameId: string }>(tabId, 'Page.navigate', { url });
            frameId = nav.frameId;
            // 同步使旧 ref 失效：MV3 SW 可能丢 Page.frameNavigated（frames.ts 里
            // context 刷新 disable/enable workaround 就是同款症状），事件驱动兜底之外
            // 在成功路径上 bump；事件随后到达再 bump 一次无害（同 tab 串行，无双拍）。
            bumpEpoch(tabId, 'navigate');
            await this.waitForLoad(tabId, sessionName, { prevUrl: currentUrl }).promise;
          }
          return { success: true, url, tabId, frameId };
        } catch (err) {
          // 自排队路径不经 registry 出口：排队/执行期间 tab 被关的裸错
          // 在这里归类成 stale_target（协议 §3.3/§3.4）。
          const stale = await asStaleTarget(tabId, sessionName, err);
          throw stale ?? err;
        }
      });
    }

    const tab = await chrome.tabs.create({ url, active: false });
    const tabId = tab.id!;
    if (session) await addToSessionGroup(tabId, session, groupTitle);
    return enqueueTab(tabId, async () => {
      try {
        await ensureAttached(tabId);
        // 新建 tab 没有「旧 url」：任何非空 complete 都是本次加载（可能已 301
        // 到终态 url），探测不得要求字面相等——快速 redirect 的 complete 事件
        // 可能早于监听注册，只能靠探测命中。
        await this.waitForLoad(tabId, sessionName, {}).promise;
        return { success: true, url, tabId };
      } catch (err) {
        // 新建 tab 在 attach/加载期间被关：同样报 stale_target；该 id 不在
        // daemon 的 owned 集里，ForgetTab 是无害 no-op。
        const stale = await asStaleTarget(tabId, sessionName, err);
        throw stale ?? err;
      }
    });
  }

  private waitForLoad(tabId: number, session: string, opts: WaitForLoadOptions): LoadWait {
    let cancel: () => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      // tab 在等待期间被关：onUpdated 永远不会再来，必须立刻 stale_target；
      // 否则烧满 30s 报误导性 "page load timeout"，daemon 也收不到 ForgetTab 信号。
      const failStale = () => {
        cleanup();
        reject(staleTargetError(tabId, session));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('navigate: page load timeout (30s)'));
      }, LOAD_TIMEOUT_MS);

      const isLoaded = (tab: chrome.tabs.Tab): boolean =>
        tab.status === 'complete' && !!tab.url && tab.url !== 'about:blank';

      // 武装门禁：complete 事件只在确认「本次导航已开始」后才算数——
      // 注册监听前已在途的旧加载的 complete 不得误当本次完成（reload 场景
      // 尤其明显：旧加载还在跑，它的 complete 先到）。武装来源两个：
      // loading 事件（跨文档加载/reload 开始）或 url 偏离 prevUrl（同文档
      // 锚点导航没有 loading，只有 url-only 事件）。
      let armed = !opts.requireLoading && opts.prevUrl === undefined;
      const urlChangedAway = (changed: string | undefined): boolean =>
        opts.prevUrl !== undefined && changed !== undefined && !samePageUrl(changed, opts.prevUrl);

      const onUpdated = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'loading') armed = true;
        // changeInfo.url 可能缺省（只带 status:'complete'），落地判定也看 tab.url：
        // /foo → /foo/ 这类规范化 complete 若不带 url 字段，单向 samePageUrl 会把
        // 落地当成「没离开 prevUrl」，错过 loading 就烧满 30s。
        if (urlChangedAway(changeInfo.url) || urlChangedAway(tab.url)) {
          armed = true;
          // 同文档导航（锚点/history API）没有 complete 事件，tab 保持 complete，
          // url 已偏离 prevUrl 即本次导航落地。
          if (isLoaded(tab)) {
            cleanup();
            resolve();
          }
          return;
        }
        if (changeInfo.status === 'complete' && armed && isLoaded(tab)) {
          cleanup();
          resolve();
        }
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) failStale();
      };
      // 两个监听器都先于探测注册：探测快照与注册之间加载完成/tab 被关也能命中，
      // 不会永远等不到事件而烧满 30s。双路 resolve 无害（cleanup 幂等）。
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);

      // reload 路径（requireLoading）：URL 相同，探测无法区分新旧 complete，跳过。
      if (opts.requireLoading) {
        cancel = cleanup;
        return;
      }

      // 探测只认「url 已偏离 prevUrl 且 complete」：navigate 确认前 tab 还是旧
      // url 的旧 complete 状态，不看 url 会把加载前状态误当成功。prevUrl 为空
      // （新建 tab）时任何非空 complete 都是本次加载（终态可能是 301 后的 url）。
      chrome.tabs.get(tabId).then(
        (tab) => {
          const landed = opts.prevUrl === undefined || !samePageUrl(tab.url ?? '', opts.prevUrl);
          // url 已偏离 prevUrl 本身就是「本次导航已开始」的证据（同 urlChangedAway
          // 的武装语义）：loading 事件可能已在监听注册前送达被错过，探测到偏离
          // 不武装的话，随后不带 url 的 complete 会被门禁吞掉，烧满 30s 假超时。
          if (landed) armed = true;
          if (isLoaded(tab) && landed) {
            cleanup();
            resolve();
          }
        },
        () => failStale(),
      );
      cancel = cleanup;
    });
    return { promise, cancel: () => cancel() };
  }
}
