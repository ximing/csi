/** Window placement for newly owned tabs (protocol §3.4). */
import { AGENT_WINDOW_SETTING } from '../shared/window-settings';

// Serialize independent-window placement across sessions, including initial creation.
let placementQueue: Promise<unknown> = Promise.resolve();

export async function createAgentTab(url: string): Promise<chrome.tabs.Tab> {
  const settings = await chrome.storage.local.get(AGENT_WINDOW_SETTING);
  const independent = settings[AGENT_WINDOW_SETTING] === true;
  if (!independent) return placeTab(url, false);
  const result = placementQueue.then(() => placeTab(url, true));
  placementQueue = result.catch(() => undefined);
  return result;
}

async function placeTab(url: string, independent: boolean): Promise<chrome.tabs.Tab> {
  const key = 'agentSharedWindow';
  let windowId: number | undefined;
  if (independent) {
    const stored = await chrome.storage.session.get(key);
    if (typeof stored[key] === 'number') {
      try {
        const win = await chrome.windows.get(stored[key]);
        if (win.type === 'normal') windowId = win.id;
      } catch {
        // The user closed the shared Agent window; create its replacement below.
      }
    }
  } else {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      windowId = win.id;
    } catch {
      // Chrome can be running with no normal windows.
    }
  }
  if (windowId !== undefined) {
    return chrome.tabs.create({ url, active: false, windowId });
  }
  // Create the requested page directly, avoiding a temporary blank tab/window.
  const win = await chrome.windows.create({ url, type: 'normal', focused: false });
  if (!win?.id || !win.tabs?.[0]?.id) throw new Error('navigate: failed to create browser window');
  if (independent) await chrome.storage.session.set({ [key]: win.id });
  return win.tabs[0];
}
