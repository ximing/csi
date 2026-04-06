/**
 * navigate (protocol §4.1): open a URL. Reuses the current tab unless
 * `newTab` is set, there is no current tab, or the current tab shows a
 * chrome:// / edge:// page (those cannot be navigated via CDP). New
 * background tabs join the session's tab group. Waits for load (30s).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand, setLastUserTabId } from '../debugger-session';
import { resetRefs } from '../refs';
import { getTrackedTab } from '../tab-manager';
import { addToSessionGroup } from '../tab-group';

const LOAD_TIMEOUT_MS = 30_000;

export class NavigateTool implements Tool {
  readonly name = 'navigate';

  async execute(args: ToolArgs): Promise<unknown> {
    const url = args.url as string | undefined;
    if (!url) throw new Error('navigate: url is required');

    // 导航后旧 @e 全部失效（协议 §4.1）
    resetRefs();

    const newTab = args.newTab as boolean | undefined;
    const session = args._session;
    const groupTitle = args.group_title as string | undefined;

    const current = newTab ? null : await getTrackedTab();

    if (!current) {
      const tab = await chrome.tabs.create({ url, active: false });
      setLastUserTabId(tab.id!);
      if (session) await addToSessionGroup(tab.id!, session, groupTitle);
      await ensureAttached(tab.id!);
      await this.waitForLoad(tab.id!);
      return { success: true, url, tabId: tab.id };
    }

    let tab = current;
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
      // Cannot CDP-navigate browser-internal pages — always open a new tab.
      tab = await chrome.tabs.create({ url, active: false });
      setLastUserTabId(tab.id!);
      if (session) await addToSessionGroup(tab.id!, session, groupTitle);
      await ensureAttached(tab.id!);
      await this.waitForLoad(tab.id!);
      return { success: true, url, tabId: tab.id };
    }

    await ensureAttached(tab.id!);
    setLastUserTabId(tab.id!);

    let frameId: string | undefined;
    const sameUrl = tab.url === url || tab.url === `${url}/`;
    if (sameUrl) {
      await sendCommand('Page.reload', { ignoreCache: true });
    } else {
      const nav = await sendCommand<{ frameId: string }>('Page.navigate', { url });
      frameId = nav.frameId;
    }
    await this.waitForLoad(tab.id!);
    return { success: true, url, tabId: tab.id, frameId };
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
