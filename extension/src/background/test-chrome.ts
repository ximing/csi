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

export function fireRemoved(tabId: number): void {
  tabs.delete(tabId);
  for (const fn of onRemoved) fn(tabId);
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
        onRemoved: { addListener: (fn: Fn) => onRemoved.push(fn) },
        onUpdated: { addListener: (fn: Fn) => onUpdated.push(fn), removeListener: () => undefined },
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
