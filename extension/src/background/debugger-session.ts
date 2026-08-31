/**
 * chrome.debugger lifecycle: which tabs are attached. Command destination
 * is always an explicit tabId argument — never a process-global "current tab".
 */
import { bumpEpoch, deleteTargetState } from './refs';

const DEBUGGER_PROTOCOL_VERSION = '1.3';

const attachedTabIds = new Set<number>();
/** Tabs that have been attached at least once; re-attach bumps documentEpoch. */
const everAttached = new Set<number>();

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabIds.delete(tabId);
  everAttached.delete(tabId);
});

chrome.debugger.onDetach.addListener((debugee) => {
  if (!debugee.tabId) return;
  attachedTabIds.delete(debugee.tabId);
});

/**
 * Attach the debugger to `tabId` (idempotent). Already-attached is a no-op.
 * Does not set any process-global current target.
 */
export async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabIds.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // not attached — fine
  }
  await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  attachedTabIds.add(tabId);
  if (everAttached.has(tabId)) {
    bumpEpoch(tabId, 'reattach');
  }
  everAttached.add(tabId);
}

/** Send a CDP command to an explicit tab. */
export async function sendCommand<T = any>(
  tabId: number,
  method: string,
  params?: object,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

export function isAttached(tabId: number): boolean {
  return attachedTabIds.has(tabId);
}

export function forgetAttached(tabId: number): void {
  attachedTabIds.delete(tabId);
}

export function deleteAttachedState(tabId: number): void {
  attachedTabIds.delete(tabId);
  everAttached.delete(tabId);
  deleteTargetState(tabId);
}
