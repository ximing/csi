import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTab,
  debuggerCalls,
  fireRemoved,
  installChrome,
  resetChromeState,
  tabsRemoved,
} from './test-chrome';
import { ToolError } from './tool-error';
import { WsClient } from './ws-client';
import * as tabQueue from './tab-queue';

installChrome();

const { registerAllTools, dispatchTool, resolveTabTarget } = await import('./registry');
registerAllTools();

/** 最小 WebSocket fake：ping/pong 用例只走 message/send 路径。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.OPEN;

  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.get('close') ?? []) fn();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  emitMessage(envelope: unknown): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }
}

type SendCommand = typeof chrome.debugger.sendCommand;

function replaceSendCommand(
  impl: (debuggee: { tabId: number }, method: string, params?: unknown) => Promise<unknown>,
): SendCommand {
  const original = chrome.debugger.sendCommand;
  (chrome.debugger as { sendCommand: SendCommand }).sendCommand = (async (
    debuggee: { tabId: number },
    method: string,
    params?: unknown,
  ) => {
    debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
    return impl(debuggee, method, params);
  }) as SendCommand;
  return original;
}

function restoreSendCommand(original: SendCommand): void {
  (chrome.debugger as { sendCommand: SendCommand }).sendCommand = original;
}

describe('dispatchTool targeting', () => {
  beforeEach(() => {
    resetChromeState();
    addTab({ id: 10, url: 'https://a.example', title: 'A', status: 'complete' });
    addTab({ id: 20, url: 'https://b.example', title: 'B', status: 'complete' });
    addTab({ id: 99, url: 'https://user.example', title: 'User', status: 'complete', active: true });
    debuggerCalls.length = 0;
    tabsRemoved.length = 0;
  });

  it('stale _tabId does not query the active tab', async () => {
    await expect(
      resolveTabTarget({ _tabId: 123, _session: 's' }),
    ).rejects.toMatchObject({ code: 'stale_target' });
  });

  it('_tabId 0 is no_session_target and does not snapshot', async () => {
    try {
      await dispatchTool('snapshot', { _tabId: 0, _session: 's', _tabIds: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('no_session_target');
    }
    expect(debuggerCalls.filter((c) => c.method === 'Accessibility.getFullAXTree')).toHaveLength(0);
  });

  it('different tab tools may overlap', async () => {
    const original = chrome.debugger.sendCommand;
    let active = 0;
    let max = 0;
    let release10!: () => void;
    const gate10 = new Promise<void>((r) => {
      release10 = r;
    });
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = (async (
      debuggee: { tabId: number },
      method: string,
    ) => {
      debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
      if (debuggee.tabId === 10 && method === 'Input.insertText') {
        active++;
        max = Math.max(max, active);
        await gate10;
        active--;
      }
      return {};
    }) as typeof chrome.debugger.sendCommand;

    const a = dispatchTool('key_type', { text: 'a', _tabId: 10, _tabIds: [10], _session: 's' });
    const b = dispatchTool('key_type', { text: 'b', _tabId: 20, _tabIds: [20], _session: 't' });
    await b;
    expect(max).toBeGreaterThanOrEqual(1);
    release10();
    await a;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
  });

  it('same tab tools do not overlap', async () => {
    const original = chrome.debugger.sendCommand;
    let active = 0;
    let max = 0;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = (async (
      debuggee: { tabId: number },
      method: string,
    ) => {
      active++;
      max = Math.max(max, active);
      if (method === 'Runtime.evaluate' || method === 'Accessibility.getFullAXTree') {
        await new Promise((r) => setTimeout(r, 30));
      }
      active--;
      debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
      return {};
    }) as typeof chrome.debugger.sendCommand;

    const a = dispatchTool('key_type', { text: 'a', _tabId: 10, _tabIds: [10], _session: 's' });
    const b = dispatchTool('key_type', { text: 'b', _tabId: 10, _tabIds: [10], _session: 's' });
    await Promise.all([a, b]);
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
    expect(max).toBe(1);
  });

  it('close_session with empty owned and borrowed current does not remove the user tab', async () => {
    const result = (await dispatchTool('close_session', {
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { closed: number };
    expect(result.closed).toBe(0);
    expect(tabsRemoved).toEqual([]);
  });

  it('close_tab refuses a borrowed target', async () => {
    const result = (await dispatchTool('close_tab', {
      _tabId: 99,
      _tabIds: [10],
      _borrowed: true,
      _session: 's',
    })) as { closed: boolean; reason?: string };
    expect(result.closed).toBe(false);
    expect(result.reason).toContain('borrowed');
    expect(tabsRemoved).toEqual([]);
  });

  it('close_tab closes an owned tab even if _borrowed is wrongly true', async () => {
    const result = (await dispatchTool('close_tab', {
      _tabId: 10,
      _tabIds: [10],
      _borrowed: true,
      _session: 's',
    })) as { closed: boolean };
    expect(result.closed).toBe(true);
    expect(tabsRemoved).toEqual([10]);
  });

  it('list_tabs does not put borrowed current into tabs', async () => {
    const result = (await dispatchTool('list_tabs', {
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { tabs: unknown[]; currentTarget?: { tabId: number; borrowed: boolean } };
    expect(result.tabs).toEqual([]);
    expect(result.currentTarget?.tabId).toBe(99);
    expect(result.currentTarget?.borrowed).toBe(true);
  });

  it('navigate on borrowed current creates a new tab and does not CDP the user tab', async () => {
    debuggerCalls.length = 0;
    const result = (await dispatchTool('navigate', {
      url: 'https://owned.example',
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { tabId: number; borrowed?: boolean };
    expect(result.tabId).not.toBe(99);
    expect(result.borrowed).toBeUndefined();
    const nav = debuggerCalls.filter((c) => c.method === 'Page.navigate' || c.method === 'Page.reload');
    expect(nav.every((c) => c.tabId !== 99)).toBe(true);
  });

  it('find_tab active:true on an owned tab returns borrowed:false', async () => {
    addTab({ id: 10, url: 'https://a.example/path', title: 'A', active: true, status: 'complete' });
    const result = (await dispatchTool('find_tab', {
      url: 'https://a.example',
      active: true,
      _tabId: 10,
      _tabIds: [10],
      _session: 's',
    })) as { borrowed: boolean; tabId: number };
    expect(result.tabId).toBe(10);
    expect(result.borrowed).toBe(false);
  });

  it('tabs.onRemoved for B does not clear A refs', async () => {
    const { assignRef, lookupRef } = await import('./refs');
    assignRef(10, 111, 'button', 'A');
    assignRef(20, 222, 'button', 'B');
    fireRemoved(20);
    expect(lookupRef(10, '@e1')?.backendDOMNodeId).toBe(111);
    expect(lookupRef(20, '@e1')).toBeUndefined();
  });
});

describe('dispatchTool concurrency rules (spec 用例 3/4/6/13b/15/17)', () => {
  beforeEach(() => {
    resetChromeState();
    addTab({ id: 10, url: 'https://a.example', title: 'A', status: 'complete' });
    addTab({ id: 20, url: 'https://b.example', title: 'B', status: 'complete' });
    addTab({ id: 99, url: 'https://user.example', title: 'User', status: 'complete', active: true });
    debuggerCalls.length = 0;
    tabsRemoved.length = 0;
  });

  // 用例 3：两个不同 _session、同一 borrowed tab，按 tab 串行，顺序按入队序（规则 3）。
  it('two sessions sharing one borrowed tab serialize on that tab in enqueue order', async () => {
    let active = 0;
    let max = 0;
    const order: string[] = [];
    const original = replaceSendCommand(async (_debuggee, method, params) => {
      if (method === 'Input.insertText') {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 30));
        order.push((params as { text?: string })?.text ?? '');
        active--;
      }
      return {};
    });
    try {
      const a = dispatchTool('key_type', { text: 'first', _tabId: 99, _session: 's1' });
      const b = dispatchTool('key_type', { text: 'second', _tabId: 99, _session: 's2' });
      await Promise.all([a, b]);
    } finally {
      restoreSendCommand(original);
    }
    expect(max).toBe(1);
    expect(order).toEqual(['first', 'second']);
  });

  // 用例 4：ref 不串台。tab 10 的 @e1 → nodeA(111)，tab 20 的 @e1 → nodeB(222)；
  // 对 tab 10 click @e1 必须用 nodeA 的 backendDOMNodeId。
  it('refs do not cross tabs: click @e1 on tab 10 resolves tab 10 node', async () => {
    const resolveCalls: { tabId: number; backendNodeId: unknown }[] = [];
    const original = replaceSendCommand(async (debuggee, method, params) => {
      const tabId = debuggee.tabId;
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['btn'] },
            {
              nodeId: 'btn',
              role: { value: 'button' },
              name: { value: tabId === 10 ? 'A' : 'B' },
              backendDOMNodeId: tabId === 10 ? 111 : 222,
            },
          ],
        };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: `f-${tabId}`, url: 'https://x.example' } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      if (method === 'DOM.resolveNode') {
        resolveCalls.push({ tabId, backendNodeId: (params as { backendNodeId?: unknown })?.backendNodeId });
        return { object: { objectId: 'obj-1' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { success: true, tag: 'BUTTON', text: 'x' } } };
      }
      return {};
    });
    try {
      await dispatchTool('snapshot', { mode: 'full', _tabId: 10, _tabIds: [10], _session: 's' });
      await dispatchTool('snapshot', { mode: 'full', _tabId: 20, _tabIds: [20], _session: 's' });
      await dispatchTool('click', { selector: '@e1', _tabId: 10, _tabIds: [10, 20], _session: 's' });
    } finally {
      restoreSendCommand(original);
    }
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toEqual({ tabId: 10, backendNodeId: 111 });
  });

  // 用例 6：tab 10 上 wait 轮询期间，tab 20 的 snapshot 明显更早完成；
  // 且 wait 期间注入 ping 立刻有 pong（handleMessage 不被工具队列堵住）。
  it('wait on tab 10 does not block tab 20 snapshot, and ping gets an immediate pong', async () => {
    const originalWs = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const original = replaceSendCommand(async (debuggee, method, params) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'Runtime.evaluate') {
        const expr = String((params as { expression?: string })?.expression ?? '');
        return { result: { value: expr.includes('iframe,frame') ? [] : false } };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: `f-${debuggee.tabId}`, url: 'https://b.example' } } };
      }
      return {};
    });
    try {
      const waitP = dispatchTool('wait', {
        text: 'never-appears',
        timeout_ms: 2000,
        interval_ms: 100,
        _tabId: 10,
        _tabIds: [10],
        _session: 's',
      });
      let waitSettled = false;
      void waitP.then(
        () => {
          waitSettled = true;
        },
        () => {
          waitSettled = true;
        },
      );

      const t0 = Date.now();
      await dispatchTool('snapshot', { mode: 'full', _tabId: 20, _tabIds: [20], _session: 't' });
      const snapMs = Date.now() - t0;
      expect(waitSettled).toBe(false);
      expect(snapMs).toBeLessThan(1500);

      const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
      await client.connect('ws://127.0.0.1:10088/ws');
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');
      socket.sent.length = 0; // 丢掉 hello，只看 pong
      socket.emitMessage({ type: 'ping' });
      expect(waitSettled).toBe(false);
      const pong = socket.sent.find((raw) => (JSON.parse(raw) as { type: string }).type === 'pong');
      expect(pong).toBeDefined();

      await expect(waitP).rejects.toThrow(/timed out/);
    } finally {
      restoreSendCommand(original);
      if (originalWs === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        (globalThis as { WebSocket?: unknown }).WebSocket = originalWs;
      }
    }
  });

  // 用例 13b：owned=[10]、borrowed current=99、省略 newTab → 新建 tab，
  // 不得 reuse 99，也不得误 reuse 10。
  it('navigate on borrowed current with owned tabs creates a new tab and reuses neither', async () => {
    debuggerCalls.length = 0;
    const result = (await dispatchTool('navigate', {
      url: 'https://fresh.example',
      _tabId: 99,
      _tabIds: [10],
      _borrowed: true,
      _session: 's',
    })) as { tabId: number; borrowed?: boolean };
    expect(result.tabId).not.toBe(99);
    expect(result.tabId).not.toBe(10);
    expect(result.borrowed).toBeUndefined();
    const nav = debuggerCalls.filter((c) => c.method === 'Page.navigate' || c.method === 'Page.reload');
    expect(nav.every((c) => c.tabId !== 99 && c.tabId !== 10)).toBe(true);
  });

  // 用例 15 后半：tab drop/onRemoved 后再 dispatchTool 同 tab → stale_target，
  // 且 enqueueTab 不被调用。
  it('dispatchTool after tab removal throws stale_target without enqueueing', async () => {
    const spy = vi.spyOn(tabQueue, 'enqueueTab');
    try {
      fireRemoved(10);
      const callsAfterDrop = spy.mock.calls.length;
      const sizeAfterDrop = tabQueue.tabQueueSize();
      await expect(
        dispatchTool('snapshot', { _tabId: 10, _tabIds: [10], _session: 's' }),
      ).rejects.toMatchObject({ code: 'stale_target' });
      expect(spy.mock.calls.length).toBe(callsAfterDrop);
      expect(tabQueue.tabQueueSize()).toBe(sizeAfterDrop);
    } finally {
      spy.mockRestore();
    }
  });

  // TOCTOU（场景 A）：resolveTabTarget 探针通过后排队的间隙 tab 被关，
  // attach 失败必须包装成 stale_target（带 details.tabId/session），不是裸错。
  it('tab closed between probe and attach throws stale_target with details', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocker = tabQueue.enqueueTab(10, () => gate);

    const p = dispatchTool('snapshot', { _tabId: 10, _tabIds: [10], _session: 's' });
    const assertion = expect(p).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });

    // 等 probe（tabs.get）与 enqueue 完成后再移除 tab，模拟探针通过后被关。
    await new Promise((r) => setTimeout(r, 0));
    fireRemoved(10);
    release();

    await assertion;
    await blocker;
  });

  // 场景 B：borrowed 的 chrome:// 受限页 tabs.get 永远成功、attach 永远失败。
  // 协议暂无对应 code：保持无 code，但错误信息必须带 tab 上下文且可读，
  // 绝不能误报 stale_target（tab 明明存在，ForgetTab 语义不适用）。
  it('restricted page target fails attach with readable error, not stale_target', async () => {
    addTab({ id: 30, url: 'chrome://settings', title: 'Settings', status: 'complete' });
    try {
      await dispatchTool('snapshot', { _tabId: 30, _tabIds: [], _session: 's' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('cannot attach debugger to session target tab 30');
      expect((err as Error).message).toContain('chrome://');
      expect((err as { code?: string }).code).toBeUndefined();
    }
  });

  // 用例 17：newTab:true 且 _tabId=10（owned）→ 不占 10 的队列；enqueue 键是 tabs.create 的新 id。
  it('navigate newTab:true with owned current enqueues on the new tab, not the current one', async () => {
    const spy = vi.spyOn(tabQueue, 'enqueueTab');
    try {
      // 占住 tab 10 的队列：若 navigate 误 enqueue(10)，下面的 await 会挂住。
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const blocker = tabQueue.enqueueTab(10, () => gate);

      const result = (await dispatchTool('navigate', {
        url: 'https://brand-new.example',
        newTab: true,
        _tabId: 10,
        _tabIds: [10],
        _session: 's',
      })) as { tabId: number };

      expect(result.tabId).not.toBe(10);
      const keys = spy.mock.calls.map((c) => c[0]);
      expect(keys.filter((k) => k === 10)).toHaveLength(1); // 只有我们手动挂的 blocker
      expect(keys).toContain(result.tabId);

      release();
      await blocker;
    } finally {
      spy.mockRestore();
    }
  });
});
