/**
 * chrome.debugger lifecycle: which tabs are attached, which tab is the
 * "current" CDP target, and cleanup when tabs close or the user detaches
 * the debugger manually.
 */

const DEBUGGER_PROTOCOL_VERSION = '1.3';

const attachedTabIds = new Set<number>();
let attachedTabId: number | null = null;
/** Last tab the user was seen actively using (fallback target). */
let lastUserTabId: number | null = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabIds.delete(tabId);
  if (attachedTabId === tabId) attachedTabId = null;
  if (lastUserTabId === tabId) lastUserTabId = null;
});

chrome.debugger.onDetach.addListener((debugee) => {
  if (!debugee.tabId) return;
  attachedTabIds.delete(debugee.tabId);
  if (attachedTabId === debugee.tabId) attachedTabId = null;
});

/**
 * Attach the debugger to `tabId` (idempotent) and make it the current
 * CDP target. A stale attachment from a previous renderer is refreshed.
 */
export async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabIds.has(tabId)) {
    attachedTabId = tabId;
    return;
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // not attached — fine
  }
  await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  attachedTabIds.add(tabId);
  attachedTabId = tabId;
}

/** Send a raw CDP command to the current target. */
export async function sendCommand<T = any>(method: string, params?: object): Promise<T> {
  if (attachedTabId === null) {
    throw new Error('No tab attached. Call attach(tabId) first.');
  }
  return (await chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params)) as T;
}

export function getAttachedTabId(): number | null {
  return attachedTabId;
}

/** Force the current CDP target without attaching (used by the tool dispatcher). */
export function setAttachedTabId(tabId: number): void {
  attachedTabId = tabId;
}

export function getLastUserTabId(): number | null {
  return lastUserTabId;
}

export function setLastUserTabId(tabId: number): void {
  lastUserTabId = tabId;
}

export function clearLastUserTabId(): void {
  lastUserTabId = null;
}

export function isAttached(tabId: number): boolean {
  return attachedTabIds.has(tabId);
}

export function forgetAttached(tabId: number): void {
  attachedTabIds.delete(tabId);
  if (attachedTabId === tabId) attachedTabId = null;
}
