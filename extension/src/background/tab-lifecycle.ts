/** One entry point for tab removal and debugger detach; modules own their state. */
interface TabLifecycle {
  /** Must be idempotent: explicit close and Chrome's event can both arrive. */
  removed?: (tabId: number) => void;
  /** Detach invalidates debugger/document state, but does not release active work. */
  detached?: (tabId: number) => void;
}

const handlers = new Set<TabLifecycle>();
let listening = false;

export function registerTabLifecycle(handler: TabLifecycle): () => void {
  if (!listening) {
    chrome.tabs.onRemoved.addListener(removeTabState);
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (tabId !== undefined) detachTabState(tabId);
    });
    listening = true;
  }
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

function notify(event: keyof TabLifecycle, tabId: number): void {
  for (const handler of handlers) {
    try {
      handler[event]?.(tabId);
    } catch (err) {
      console.error(`[tab-lifecycle] ${event} cleanup failed for tab ${tabId}`, err);
    }
  }
}

/** Only call after the tab is confirmed gone. Does not cancel in-flight work. */
export function removeTabState(tabId: number): void {
  notify('removed', tabId);
}

export function detachTabState(tabId: number): void {
  notify('detached', tabId);
}
