/**
 * Resolves "the current tab" for single-tab tools (protocol §3.4):
 *   1. the debugger-attached tab,
 *   2. the last tab the user was seen using,
 *   3. the browser's active tab.
 */
import {
  getAttachedTabId,
  getLastUserTabId,
  setLastUserTabId,
  clearLastUserTabId,
  forgetAttached,
} from './debugger-session';

/** Tracked tab (attached or last-user) that still exists, else null. */
export async function getTrackedTab(): Promise<chrome.tabs.Tab | null> {
  const attachedId = getAttachedTabId();
  if (attachedId !== null) {
    try {
      const tab = await chrome.tabs.get(attachedId);
      if (tab) return tab;
    } catch {
      forgetAttached(attachedId);
    }
  }
  const lastUserId = getLastUserTabId();
  if (lastUserId !== null) {
    try {
      const tab = await chrome.tabs.get(lastUserId);
      if (tab) return tab;
    } catch {
      clearLastUserTabId();
    }
  }
  return null;
}

/**
 * Current tab for single-tab tools; falls back to the active tab of the
 * current window and remembers it as the user's tab.
 */
export async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const tracked = await getTrackedTab();
  if (tracked) return tracked;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error('No active tab found');
  setLastUserTabId(active.id);
  return active;
}

export { setLastUserTabId };
