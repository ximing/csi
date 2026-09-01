/**
 * navigate (protocol §4.1): open a URL. Reuses an *owned* current tab only.
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
          const sameUrl = currentUrl === url || currentUrl === `${url}/`;
          if (sameUrl) {
            await sendCommand(tabId, 'Page.reload', { ignoreCache: true });
          } else {
            const nav = await sendCommand<{ frameId: string }>(tabId, 'Page.navigate', { url });
            frameId = nav.frameId;
          }
          // 同步使旧 ref 失效：MV3 SW 可能丢 Page.frameNavigated（frames.ts 里
          // context 刷新 disable/enable workaround 就是同款症状），事件驱动兜底之外
          // 在成功路径上 bump；事件随后到达再 bump 一次无害（同 tab 串行，无双拍）。
          bumpEpoch(tabId, sameUrl ? 'reload' : 'navigate');
          await this.waitForLoad(tabId, sessionName);
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
        await this.waitForLoad(tabId, sessionName);
        return { success: true, url, tabId };
      } catch (err) {
        // 新建 tab 在 attach/加载期间被关：同样报 stale_target；该 id 不在
        // daemon 的 owned 集里，ForgetTab 是无害 no-op。
        const stale = await asStaleTarget(tabId, sessionName, err);
        throw stale ?? err;
      }
    });
  }

  private waitForLoad(tabId: number, session: string): Promise<void> {
    return new Promise((resolve, reject) => {
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

      const onUpdated = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete' && isLoaded(tab)) {
          cleanup();
          resolve();
        }
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) failStale();
      };
      // 先于探测注册：探测往返之间 tab 被关也能命中。
      chrome.tabs.onRemoved.addListener(onRemoved);

      // 用 promise 风格探测：回调风格下 tab 不存在时回调拿到 undefined，
      // 直接解引用会抛 TypeError，Promise 永不了结、只能等 30s 超时。
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (isLoaded(tab)) {
            cleanup();
            resolve();
          } else {
            chrome.tabs.onUpdated.addListener(onUpdated);
          }
        },
        () => failStale(),
      );
    });
  }
}
