/** Shared chrome fake for vitest. */

type Fn = (...args: any[]) => void;

export interface FakeTab {
  id: number;
  url?: string;
  title?: string;
  status?: string;
  active?: boolean;
  groupId?: number;
}

export const debuggerCalls: { tabId: number; method: string; t: number }[] = [];
export const tabsRemoved: number[] = [];

const onRemoved: Fn[] = [];
const onDetach: Fn[] = [];
const onEvent: Fn[] = [];
const onUpdated: Fn[] = [];
const tabs = new Map<number, FakeTab>();
let nextCreateId = 200;

export function resetChromeState(): void {
  debuggerCalls.length = 0;
  tabsRemoved.length = 0;
  tabs.clear();
  nextCreateId = 200;
}

export function addTab(tab: FakeTab): void {
  tabs.set(tab.id, { status: 'complete', ...tab });
}

/** 从 fake 中移除 tab 但不发 onRemoved（模拟事件尚未送达的竞态窗口）。 */
export function removeTabSilently(tabId: number): void {
  tabs.delete(tabId);
}

export function fireRemoved(tabId: number): void {
  tabs.delete(tabId);
  // 迭代快照：监听者（如 navigate 的 waitForLoad）会在回调里注销自己，
  // 直接迭代原数组会跳过后续监听者。
  for (const fn of [...onRemoved]) fn(tabId);
}

/** 模拟 chrome.tabs.onUpdated 事件；tab 参数缺省取当前存储的 tab。 */
export function fireUpdated(
  tabId: number,
  changeInfo: { status?: string; url?: string },
  tab?: FakeTab,
): void {
  const stored = tab ?? tabs.get(tabId) ?? { id: tabId };
  for (const fn of [...onUpdated]) fn(tabId, changeInfo, stored);
}

/** 当前注册的 onUpdated / onRemoved 监听器数（断言监听泄漏用）。 */
export function updatedListenerCount(): number {
  return onUpdated.length;
}

export function removedListenerCount(): number {
  return onRemoved.length;
}

/**
 * 局部覆写 chrome.debugger.sendCommand：按 method 分发到 handlers（可抛错模拟
 * 真实 Chrome 的 rejection），未命中的回退默认 fake。用完必须调 restore()。
 */
export function stubSendCommand(handlers: Record<string, (params: any) => unknown>): {
  calls: { method: string; params: any }[];
  restore: () => void;
} {
  const original = chrome.debugger.sendCommand;
  const calls: { method: string; params: any }[] = [];
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
    (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (h) return h(params ?? {});
      return original(debuggee, method, params as object);
    }) as typeof chrome.debugger.sendCommand;
  return {
    calls,
    restore: () => {
      (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
        original;
    },
  };
}

export function fireDebuggerEvent(tabId: number, method: string, params: unknown): void {
  for (const fn of onEvent) fn({ tabId }, method, params);
}

let installed = false;

export function installChrome(): void {
  if (installed && (globalThis as { chrome?: unknown }).chrome) return;
  installed = true;
  Object.assign(globalThis, {
    chrome: {
      tabs: {
        get: (id: number, cb?: (tab: FakeTab) => void) => {
          const tab = tabs.get(id);
          if (!tab) {
            const err = new Error(`no tab ${id}`);
            if (cb) throw err;
            return Promise.reject(err);
          }
          if (cb) {
            cb(tab);
            return;
          }
          return Promise.resolve(tab);
        },
        create: async (opts: { url?: string; active?: boolean }) => {
          const id = nextCreateId++;
          const tab: FakeTab = {
            id,
            url: opts.url,
            title: '',
            status: 'complete',
            active: opts.active ?? false,
          };
          tabs.set(id, tab);
          return tab;
        },
        remove: async (id: number) => {
          if (!tabs.has(id)) throw new Error(`no tab ${id}`);
          tabs.delete(id);
          tabsRemoved.push(id);
          for (const fn of onRemoved) fn(id);
        },
        query: async () => {
          throw new Error('tabs.query should not be used as silent fallback');
        },
        onRemoved: {
          addListener: (fn: Fn) => onRemoved.push(fn),
          removeListener: (fn: Fn) => {
            const i = onRemoved.indexOf(fn);
            if (i >= 0) onRemoved.splice(i, 1);
          },
        },
        onUpdated: {
          addListener: (fn: Fn) => onUpdated.push(fn),
          removeListener: (fn: Fn) => {
            const i = onUpdated.indexOf(fn);
            if (i >= 0) onUpdated.splice(i, 1);
          },
        },
      },
      windows: {
        getLastFocused: async () => {
          const active = [...tabs.values()].find((t) => t.active);
          return { tabs: active ? [active] : [] };
        },
      },
      debugger: {
        attach: async (debuggee: { tabId: number }) => {
          const tab = tabs.get(debuggee.tabId);
          if (!tab) throw new Error(`No tab with given id: ${debuggee.tabId}.`);
          if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
            throw new Error(`Cannot access a ${tab.url.slice(0, tab.url.indexOf(':'))}:// URL`);
          }
        },
        detach: async () => undefined,
        sendCommand: async (debuggee: { tabId: number }, method: string) => {
          debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
          if (method === 'Page.enable' || method === 'Page.navigate' || method === 'Page.reload') {
            return { frameId: 'f' };
          }
          if (method === 'Network.enable' || method === 'Network.disable') return {};
          return {};
        },
        getTargets: async () => [],
        onEvent: { addListener: (fn: Fn) => onEvent.push(fn) },
        onDetach: { addListener: (fn: Fn) => onDetach.push(fn) },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async () => ({ title: '' }),
        onRemoved: { addListener: () => undefined },
      },
      runtime: { getManifest: () => ({ version: '0.7.0' }) },
      storage: {
        local: { get: async () => ({}), set: async () => undefined },
        onChanged: { addListener: () => undefined },
      },
    },
  });
}
