/**
 * find_tab (protocol §4.2 / §3.4): locate a tab by URL domain.
 * borrowed = foundId ∉ owned _tabIds.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { ensureAttached } from '../debugger-session';
import { enqueueTab } from '../tab-queue';
import { isOwnedTab, sessionTabIds } from '../session-tabs';

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

  async execute(args: ToolArgs, _target: TargetContext): Promise<unknown> {
    const url = args.url as string | undefined;
    if (!url) throw new Error('find_tab: url is required');

    const useActive = args.active as boolean | undefined;
    const pattern = toHostPattern(url);

    let foundId: number;
    let foundUrl: string;
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
      foundId = tab.id;
      foundUrl = tab.url ?? url;
    } else {
      let hit: { id: number; url: string } | undefined;
      for (const tabId of sessionTabIds(args)) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && hostMatches(tab.url, pattern)) {
            hit = { id: tabId, url: tab.url };
            break;
          }
        } catch {
          continue;
        }
      }
      if (!hit) {
        throw new Error(
          `find_tab: no tab matching ${url} in this session — use navigate to open it, or pass active:true to act on a tab you already have open`,
        );
      }
      foundId = hit.id;
      foundUrl = hit.url;
    }

    const borrowed = !isOwnedTab(args, foundId);
    return enqueueTab(foundId, async () => {
      await ensureAttached(foundId);
      return { success: true, url: foundUrl, tabId: foundId, borrowed };
    });
  }
}
