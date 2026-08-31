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
import { ToolError } from '../tool-error';

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
        if (!newTab) {
          throw new ToolError(
            `session target tab ${currentId} is no longer available`,
            'stale_target',
            { tabId: currentId, session: sessionName },
          );
        }
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
        await this.waitForLoad(tabId);
        return { success: true, url, tabId, frameId };
      });
    }

    const tab = await chrome.tabs.create({ url, active: false });
    const tabId = tab.id!;
    if (session) await addToSessionGroup(tabId, session, groupTitle);
    return enqueueTab(tabId, async () => {
      await ensureAttached(tabId);
      await this.waitForLoad(tabId);
      return { success: true, url, tabId };
    });
  }

  private waitForLoad(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
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
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };

      chrome.tabs.get(tabId, (tab) => {
        if (isLoaded(tab)) {
          clearTimeout(timer);
          resolve();
        } else {
          chrome.tabs.onUpdated.addListener(onUpdated);
        }
      });
    });
  }
}
