/**
 * frames.ts 帧发现与 context 表测试（协议 §4.1）：
 * listAllFrames 的三路来源合并（CDP frameTree / DOM iframe 行 / OOPIF target）、
 * judgeIsolated 的各 isolated 判定、findFrame/resolveFrame/frameById/isolatedSrcSet，
 * 以及 contextIdForFrame 的缓存 / 事件刷新 / 超时兜底三路与事件清理。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTab, installChrome, resetChromeState } from './test-chrome';

installChrome();

// frames.ts 的 debugger 监听器需要能以任意 source 形状触发（含 tabId 缺失），
// test-chrome 的 fireDebuggerEvent 做不到，这里换成自己的捕获数组（仅本文件生效）。
type RawListener = (...args: any[]) => void;
const onEventListeners: RawListener[] = [];
const onDetachListeners: RawListener[] = [];
const commands: { tabId: number; method: string; params?: object }[] = [];
let commandResults: Record<string, unknown> = {};
let debuggerTargets: { type: string; tabId?: number; url?: string }[] = [];

chrome.debugger.onEvent = { addListener: (fn: RawListener) => onEventListeners.push(fn) } as any;
chrome.debugger.onDetach = { addListener: (fn: RawListener) => onDetachListeners.push(fn) } as any;
chrome.debugger.sendCommand = (async (
  debuggee: { tabId: number },
  method: string,
  params?: object,
) => {
  commands.push({ tabId: debuggee.tabId, method, params });
  if (method in commandResults) return commandResults[method];
  return {};
}) as typeof chrome.debugger.sendCommand;
chrome.debugger.getTargets = (async () =>
  debuggerTargets) as typeof chrome.debugger.getTargets;

const frames = await import('./frames');
const refs = await import('./refs');

function fireDebugger(tabId: number | undefined, method: string, params: unknown): void {
  for (const fn of [...onEventListeners]) fn({ tabId }, method, params);
}

function fireDetach(tabId: number): void {
  for (const fn of [...onDetachListeners]) fn({ tabId });
}

interface CdpFrameInput {
  id: string;
  parentId?: string;
  url: string;
  name?: string;
  securityOrigin?: string;
}

interface DomRow {
  src: string;
  name: string;
  sandbox: string | null;
  sameDoc: boolean;
}

/** 由扁平帧表构造 Page.getFrameTree 的树。 */
function frameTreeOf(list: CdpFrameInput[]): unknown {
  const nodes = new Map<string, { frame: CdpFrameInput; childFrames: unknown[] }>(
    list.map((f) => [f.id, { frame: f, childFrames: [] }]),
  );
  let root: { frame: CdpFrameInput; childFrames: unknown[] } | undefined;
  for (const f of list) {
    const node = nodes.get(f.id)!;
    const parent = f.parentId ? nodes.get(f.parentId) : undefined;
    if (f.parentId && parent) parent.childFrames.push(node);
    else if (!f.parentId) root = node;
  }
  return { frameTree: root };
}

function setScene(cdp: CdpFrameInput[], domRows: DomRow[]): void {
  commandResults = {
    'Page.getFrameTree': frameTreeOf(cdp),
    'Runtime.evaluate': { result: { value: domRows } },
  };
}

const TOP: CdpFrameInput = { id: 'top', url: 'https://a.example/page' };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  addTab({ id: 20, url: 'https://b.example' });
  refs.deleteTargetState(10);
  refs.deleteTargetState(20);
  frames.clearContextsForTab(10);
  frames.clearContextsForTab(20);
  commands.length = 0;
  commandResults = {};
  debuggerTargets = [];
});

describe('listAllFrames 帧发现', () => {
  it('顶层帧 parentId 为空且不 isolated；同名域子帧不 isolated，CDP name 优先于 DOM 行', async () => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://a.example/embed',
          name: 'cdp-name',
          securityOrigin: 'https://a.example',
        },
      ],
      [{ src: 'https://a.example/embed', name: 'dom-name', sandbox: null, sameDoc: true }],
    );
    const all = await frames.listAllFrames(10);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ frameId: 'top', parentId: '', isolated: false, name: '' });
    expect(all[1]).toMatchObject({
      frameId: 'c1',
      parentId: 'top',
      url: 'https://a.example/embed',
      name: 'cdp-name',
      isolated: false,
    });
  });

  it('CDP 帧无 name 时回落到 DOM 行的 name', async () => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://a.example/embed',
          securityOrigin: 'https://a.example',
        },
      ],
      [{ src: 'https://a.example/embed', name: 'dom-name', sandbox: null, sameDoc: true }],
    );
    const all = await frames.listAllFrames(10);
    expect(all[1]!.name).toBe('dom-name');
  });

  it('cross-origin / 沙箱缺 allow-same-origin / 跨文档 / data: / 无 securityOrigin 的帧都判 isolated', async () => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'cross',
          parentId: 'top',
          url: 'https://b.example/x',
          securityOrigin: 'https://b.example',
        },
        {
          id: 'sb',
          parentId: 'top',
          url: 'https://a.example/sb',
          securityOrigin: 'https://a.example',
        },
        {
          id: 'xd',
          parentId: 'top',
          url: 'https://a.example/xd',
          securityOrigin: 'https://a.example',
        },
        {
          id: 'data',
          parentId: 'top',
          url: 'data:text/html,hi',
          securityOrigin: 'https://a.example',
        },
        { id: 'nosec', parentId: 'top', url: 'https://a.example/nosec' },
        {
          id: 'nulsec',
          parentId: 'top',
          url: 'https://a.example/nulsec',
          securityOrigin: 'null',
        },
        { id: 'colon', parentId: 'top', url: 'https://a.example/colon', securityOrigin: '://' },
      ],
      [
        { src: 'https://b.example/x', name: '', sandbox: null, sameDoc: true },
        { src: 'https://a.example/sb', name: '', sandbox: 'allow-scripts', sameDoc: true },
        { src: 'https://a.example/xd', name: '', sandbox: null, sameDoc: false },
      ],
    );
    const all = await frames.listAllFrames(10);
    const byId = new Map(all.map((f: any) => [f.frameId, f]));
    expect(byId.get('cross')!.isolated).toBe(true); // securityOrigin !== topOrigin
    expect(byId.get('sb')!.isolated).toBe(true); // sandbox 无 allow-same-origin
    expect(byId.get('xd')!.isolated).toBe(true); // contentDocument 为空（跨文档）
    expect(byId.get('data')!.isolated).toBe(true); // data: URL
    expect(byId.get('nosec')!.isolated).toBe(true); // 缺 securityOrigin
    expect(byId.get('nulsec')!.isolated).toBe(true); // securityOrigin "null"
    expect(byId.get('colon')!.isolated).toBe(true); // securityOrigin "://"
  });

  it('沙箱带 allow-same-origin 且同文档的同域帧不 isolated；无 DOM 行的同域帧也不 isolated', async () => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'ok-sb',
          parentId: 'top',
          url: 'https://a.example/ok-sb',
          securityOrigin: 'https://a.example',
        },
        {
          id: 'no-row',
          parentId: 'top',
          url: 'https://a.example/no-row',
          securityOrigin: 'https://a.example',
        },
      ],
      [
        {
          src: 'https://a.example/ok-sb',
          name: '',
          sandbox: 'allow-scripts allow-same-origin',
          sameDoc: true,
        },
      ],
    );
    const all = await frames.listAllFrames(10);
    const byId = new Map(all.map((f: any) => [f.frameId, f]));
    expect(byId.get('ok-sb')!.isolated).toBe(false);
    expect(byId.get('no-row')!.isolated).toBe(false);
  });

  it('顶层 origin 解析失败（topOrigin 为空）时所有子帧判 isolated', async () => {
    setScene(
      [
        { id: 'top', url: 'not a url', securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://a.example/embed',
          securityOrigin: 'https://a.example',
        },
      ],
      [],
    );
    const all = await frames.listAllFrames(10);
    expect(all[1]!.isolated).toBe(true);
  });

  it('DOM 里出现但 CDP frameTree 没有的 iframe 补成 isolated:<src> 条目', async () => {
    setScene(
      [{ ...TOP, securityOrigin: 'https://a.example' }],
      [{ src: 'https://c.example/lazy', name: 'lazy', sandbox: null, sameDoc: false }],
    );
    const all = await frames.listAllFrames(10);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({
      frameId: 'isolated:https://c.example/lazy',
      parentId: 'top',
      url: 'https://c.example/lazy',
      name: 'lazy',
      isolated: true,
    });
  });

  it('OOPIF target 补成 isolated 条目，且只认本 tab 的 iframe 类型 target，已知 url 不重复', async () => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://a.example/embed',
          securityOrigin: 'https://a.example',
        },
      ],
      [{ src: 'https://a.example/embed', name: '', sandbox: null, sameDoc: true }],
    );
    debuggerTargets = [
      { type: 'iframe', tabId: 10, url: 'https://d.example/oopif' }, // 新 OOPIF → 补条目
      { type: 'iframe', tabId: 10, url: 'https://a.example/embed' }, // 已知 → 不重复
      { type: 'iframe', tabId: 20, url: 'https://other.example/x' }, // 其他 tab → 排除
      { type: 'page', tabId: 10, url: 'https://p.example/' }, // 非 iframe → 排除
      { type: 'iframe', tabId: 10, url: '' }, // 空 url → 排除
    ];
    const all = await frames.listAllFrames(10);
    expect(all.map((f: any) => f.frameId)).toEqual([
      'top',
      'c1',
      'isolated:https://d.example/oopif',
    ]);
    expect(all[2]).toMatchObject({ url: 'https://d.example/oopif', name: '', isolated: true });
  });

  it('DOM 行 src 与 CDP 帧重复时不补条目；Runtime.evaluate 无结果时只返回 CDP 帧', async () => {
    commandResults = {
      'Page.getFrameTree': frameTreeOf([
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://a.example/embed',
          securityOrigin: 'https://a.example',
        },
      ]),
      'Runtime.evaluate': {}, // result 缺失 → 空行
    };
    const all = await frames.listAllFrames(10);
    expect(all).toHaveLength(2);
    expect(all.map((f: any) => f.isolated)).toEqual([false, false]);
  });
});

describe('findFrame / resolveFrame / frameById / isolatedSrcSet', () => {
  beforeEach(() => {
    setScene(
      [
        { ...TOP, securityOrigin: 'https://a.example' },
        {
          id: 'c1',
          parentId: 'top',
          url: 'https://x.example/one',
          securityOrigin: 'https://x.example',
        },
        {
          id: 'c2',
          parentId: 'top',
          url: 'https://x.example/two',
          securityOrigin: 'https://x.example',
        },
        {
          id: 'ok',
          parentId: 'top',
          url: 'https://a.example/inner',
          securityOrigin: 'https://a.example',
        },
      ],
      [],
    );
  });

  it('frameId 精确命中优先于 url 子串命中', async () => {
    // "c1" 同时是 c2 url 的子串？不是——用 url 值同时能子串命中多帧、frameId 唯一命中的场景
    const hit = await frames.findFrame(10, 'c1');
    expect(hit.frameId).toBe('c1');
  });

  it('url 子串唯一命中时返回该帧', async () => {
    const hit = await frames.findFrame(10, 'two');
    expect(hit.frameId).toBe('c2');
  });

  it('顶层帧不参与 findFrame（只搜子帧与 isolated 条目）', async () => {
    await expect(frames.findFrame(10, 'top')).rejects.toThrow(/no frame matching/);
  });

  it('无命中抛错', async () => {
    await expect(frames.findFrame(10, 'https://z.example/none')).rejects.toThrow(
      /no frame matching "https:\/\/z.example\/none"/,
    );
  });

  it('多命中抛错并列出前 5 个 url', async () => {
    const cdp: CdpFrameInput[] = [{ ...TOP, securityOrigin: 'https://a.example' }];
    for (let i = 1; i <= 6; i++) {
      cdp.push({
        id: `m${i}`,
        parentId: 'top',
        url: `https://x.example/multi-${i}`,
        securityOrigin: 'https://x.example',
      });
    }
    setScene(cdp, []);
    await expect(frames.findFrame(10, 'multi-')).rejects.toThrow(/multiple frames match/);
  });

  it('resolveFrame 对 isolated 帧抛 cross-origin 错误，对普通帧原样返回', async () => {
    await expect(frames.resolveFrame(10, 'one')).rejects.toThrow(
      /cross-origin frame "https:\/\/x.example\/one" is not supported/,
    );
    await expect(frames.resolveFrame(10, 'ok')).resolves.toMatchObject({ frameId: 'ok' });
  });

  it('frameById 命中返回；未命中抛 FRAME_GONE', async () => {
    await expect(frames.frameById(10, 'ok')).resolves.toMatchObject({ frameId: 'ok' });
    await expect(frames.frameById(10, 'gone')).rejects.toThrow(frames.FRAME_GONE_ERROR);
  });

  it('isolatedSrcSet 返回 isolated 帧的 url 集合', async () => {
    const set = await frames.isolatedSrcSet(10);
    expect([...set].sort()).toEqual(['https://x.example/one', 'https://x.example/two']);
  });
});

describe('contextIdForFrame 与 context 表', () => {
  function ctxEvent(tabId: number, frameId: string, id: number, isDefault = true): void {
    fireDebugger(tabId, 'Runtime.executionContextCreated', {
      context: { id, auxData: { frameId, isDefault } },
    });
  }

  /** 走满 1s 等待超时，返回最终 contextId（验证非缓存路径）。 */
  async function contextViaTimeout(tabId: number, frameId: string): Promise<number> {
    vi.useFakeTimers();
    try {
      const p = frames.contextIdForFrame(tabId, frameId);
      await vi.advanceTimersByTimeAsync(1000);
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it('命中缓存直接返回，不再 Runtime.disable/enable', async () => {
    ctxEvent(10, 'f1', 7);
    commands.length = 0;
    await expect(frames.contextIdForFrame(10, 'f1')).resolves.toBe(7);
    expect(commands.map((c) => c.method)).toEqual([]);
  });

  it('无缓存时 Runtime.disable/enable 刷新，事件到达后由 waiter 返回', async () => {
    const p = frames.contextIdForFrame(10, 'f2');
    // waiter 在首个 await 之前就已注册，立刻触发事件即可命中
    ctxEvent(10, 'f2', 55);
    await expect(p).resolves.toBe(55);
    expect(commands.map((c) => c.method)).toEqual(['Runtime.disable', 'Runtime.enable']);
  });

  it('事件一直不来时超时兜底 Page.createIsolatedWorld', async () => {
    commandResults = { 'Page.createIsolatedWorld': { executionContextId: 4242 } };
    await expect(contextViaTimeout(10, 'f3')).resolves.toBe(4242);
    expect(commands.map((c) => c.method)).toEqual([
      'Runtime.disable',
      'Runtime.enable',
      'Page.createIsolatedWorld',
    ]);
    const world = commands.find((c) => c.method === 'Page.createIsolatedWorld');
    expect(world?.params).toMatchObject({ frameId: 'f3', worldName: 'csi-frame' });
  });

  it('非 default context / 缺 frameId / 缺 id 的执行上下文事件不入表', async () => {
    ctxEvent(10, 'f4', 100, false); // isDefault false
    fireDebugger(10, 'Runtime.executionContextCreated', {
      context: { id: 101, auxData: { isDefault: true } }, // 无 frameId
    });
    fireDebugger(10, 'Runtime.executionContextCreated', {
      context: { auxData: { frameId: 'f4', isDefault: true } }, // 无 id
    });
    commandResults = { 'Page.createIsolatedWorld': { executionContextId: 4242 } };
    await expect(contextViaTimeout(10, 'f4')).resolves.toBe(4242); // 缓存没被污染，走兜底
  });

  it('source 无 tabId 的事件被忽略', () => {
    expect(() =>
      fireDebugger(undefined, 'Runtime.executionContextCreated', {
        context: { id: 1, auxData: { frameId: 'f9', isDefault: true } },
      }),
    ).not.toThrow();
  });

  it('executionContextsCleared 只清该 tab 的 context', async () => {
    ctxEvent(10, 'f1', 7);
    ctxEvent(20, 'f5', 44);
    fireDebugger(20, 'Runtime.executionContextsCleared', {});
    // tab 20 被清 → 走兜底；tab 10 仍走缓存
    commandResults = { 'Page.createIsolatedWorld': { executionContextId: 4242 } };
    await expect(contextViaTimeout(20, 'f5')).resolves.toBe(4242);
    commands.length = 0;
    await expect(frames.contextIdForFrame(10, 'f1')).resolves.toBe(7);
    expect(commands).toEqual([]);
  });

  it('tab 关闭时清理 refs、队列与 context', async () => {
    const { fireRemoved } = await import('./test-chrome');
    ctxEvent(10, 'f1', 7);
    refs.assignRef(10, 111, 'button', 'A');
    const { tabQueueSize, enqueueTab } = await import('./tab-queue');
    enqueueTab(10, async () => undefined);
    expect(tabQueueSize()).toBe(1);

    fireRemoved(10);

    expect(tabQueueSize()).toBe(0);
    expect(() => refs.consumeRef(10, 'click', '@e1')).toThrow(/unknown ref/); // 状态被删
    commandResults = { 'Page.createIsolatedWorld': { executionContextId: 4242 } };
    await expect(contextViaTimeout(10, 'f1')).resolves.toBe(4242); // context 被清
  });

  it('debugger onDetach：bump epoch 并清该 tab 的 context', async () => {
    ctxEvent(10, 'f1', 7);
    refs.assignRef(10, 111, 'button', 'A');
    fireDetach(10);
    expect(() => refs.consumeRef(10, 'click', '@e1')).toThrow(/stale ref/); // epoch 提升了
    commandResults = { 'Page.createIsolatedWorld': { executionContextId: 4242 } };
    await expect(contextViaTimeout(10, 'f1')).resolves.toBe(4242); // context 被清
  });

  it('onDetach 无 tabId 时忽略', () => {
    expect(() => {
      for (const fn of [...onDetachListeners]) fn({});
    }).not.toThrow();
  });

  it('frameNavigated 事件体缺 frame / 缺 id 时不抛错', () => {
    expect(() => fireDebugger(10, 'Page.frameNavigated', {})).not.toThrow();
    expect(() =>
      fireDebugger(10, 'Page.frameNavigated', { frame: { parentId: 'top' } }), // 有 parentId 无 id
    ).not.toThrow();
  });
});
