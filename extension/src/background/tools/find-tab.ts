/**
 * find_tab (protocol §4.2 / §3.4): locate a tab by URL domain. By default
 * only the session's own tabs (`_tabIds`) are searched; `active:true`
 * borrows the tab the user is currently viewing (returned with
 * `borrowed:true`, never pulled into the session group).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, setLastUserTabId } from '../debugger-session';

/** Normalize user input into a match-pattern-ish `*://host/*` string. */
function toHostPattern(url: string): string {
  if (url.includes('*')) return url;
  try {
    return `*://${new URL(url).hostname}/*`;
  } catch {
    return `*://${url.replace(/^\.+/, '')}/*`;
  }
}

function hostMatches(tabUrl: string, pattern: string): boolean {
  try {
    const host = pattern.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
    return new URL(tabUrl).hostname === host;
  } catch {
    return false;
  }
}

export class FindTabTool implements Tool {
  readonly name = 'find_tab';

  async execute(args: ToolArgs): Promise<unknown> {
    const url = args.url as string | undefined;
    if (!url) throw new Error('find_tab: url is required');

    const useActive = args.active as boolean | undefined;
    const sessionTabIds = args._tabIds ?? [];
    const pattern = toHostPattern(url);

    if (useActive) {
      const window = await chrome.windows.getLastFocused({
        populate: true,
        windowTypes: ['normal'],
      });
      const tab = window.tabs?.find((t) => t.active && t.url && hostMatches(t.url, pattern));
      if (!tab?.id) {
        throw new Error(
          `find_tab(active:true): no foreground tab matching ${url} — the user isn't viewing that page right now`,
        );
      }
      await ensureAttached(tab.id);
      setLastUserTabId(tab.id);
      return { success: true, url: tab.url ?? url, tabId: tab.id, borrowed: true };
    }

    for (const tabId of sessionTabIds) {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        continue;
      }
      if (tab.url && hostMatches(tab.url, pattern)) {
        await ensureAttached(tabId);
        setLastUserTabId(tabId);
        return { success: true, url: tab.url, tabId, borrowed: false };
      }
    }

    throw new Error(
      `find_tab: no tab matching ${url} in this session — use navigate to open it, or pass active:true to act on a tab you already have open`,
    );
  }
}
