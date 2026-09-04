/**
 * navigate 工具层测试：成功路径同步 bump epoch（MV3 SW 丢 Page.frameNavigated
 * 时的兜底）；sameUrl 按任务执行时的当前 url 判定，不用排队前捕获的旧 url；
 * tab 在各阶段死亡一律快速 stale_target（协议 §3.3/§3.4），不出现误导性超时。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTab,
  debuggerCalls,
  fireRemoved,
  fireUpdated,
  installChrome,
  removedListenerCount,
  removeTabSilently,
  resetChromeState,
  stubSendCommand,
  updatedListenerCount,
} from '../test-chrome';

installChrome();

const { NavigateTool } = await import('./navigate');
const { enqueueTab, dropTabQueue } = await import('../tab-queue');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
  dropTabQueue(10);
});

describe('navigate ref 失效', () => {
  it('导航成功路径同步 bump epoch，旧 @e 变 stale_ref（不依赖 frameNavigated 事件）', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    // 真实 Chrome 的跨文档加载:先 loading 后 complete
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://b.example', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
    const res = (await pending) as { success: boolean; url: string };
    expect(res.success).toBe(true);
    expect(() => refs.consumeRef(10, 'click', '@e1')).toThrow(/stale ref/);
  });

  it('sameUrl 用执行时的当前 url：排队期间被并发导航到目标 url 后应 reload 而非 navigate', async () => {
    // 占住该 tab 队列，任务里模拟页面被并发导航到目标 url。
    const first = enqueueTab(10, async () => {
      addTab({ id: 10, url: 'https://b.example' });
    });
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await first;
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(true);
    });
    fireUpdated(10, { status: 'loading' });
    fireUpdated(10, { status: 'complete' });
    const res = (await pending) as { success: boolean; url: string };
    expect(res.success).toBe(true);
    expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(false);
  });
});

describe('navigate 加载完成的判定', () => {
  it('探测要求 url 匹配：旧 url 的 complete 状态不得被误认为本次加载完成', async () => {
    // fake 的 Page.navigate 不改 tab url：探测看到的是旧 url + 旧 complete。
    let settled = false;
    const pending = new NavigateTool()
      .execute({ url: 'https://b.example', _tabId: 10, _tabIds: [10] }, ctx)
      .then((r) => {
        settled = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://b.example', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true, url: 'https://b.example' });
  });

  it('sameUrl reload 不吃旧 complete 探测：等 reload 后的真实 loading→complete 序列', async () => {
    // tab 已是 complete（reload 前的旧状态）：URL 相同，探测无法区分新旧，
    // 若探测即 resolve 会在 reload 仍在进行时提前返回成功。
    let settled = false;
    const pending = new NavigateTool()
      .execute({ url: 'https://a.example', _tabId: 10, _tabIds: [10] }, ctx)
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    fireUpdated(10, { status: 'loading' });
    fireUpdated(10, { status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true, url: 'https://a.example' });
  });

  it('waitForLoad 先注册 onUpdated 再探测：探测往返前的 complete 事件不丢', async () => {
    addTab({ id: 10, url: 'https://a.example', status: 'loading' });
    const order: string[] = [];
    const origGet = chrome.tabs.get;
    const origAdd = chrome.tabs.onUpdated.addListener;
    (chrome.tabs as { get: unknown }).get = (id: number) => {
      order.push('get');
      return origGet(id);
    };
    chrome.tabs.onUpdated.addListener = ((fn: unknown) => {
      order.push('addListener');
      origAdd(fn as never);
    }) as typeof chrome.tabs.onUpdated.addListener;
    try {
      const pending = new NavigateTool().execute(
        { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 20));
      // 最后一次探测（waitForLoad 内）之前必须已注册 onUpdated
      expect(order.indexOf('addListener')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('addListener')).toBeLessThan(order.lastIndexOf('get'));
      fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://b.example', status: 'loading' });
      fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
      await pending;
    } finally {
      (chrome.tabs as { get: unknown }).get = origGet;
      chrome.tabs.onUpdated.addListener = origAdd;
    }
  });
});

describe('navigate URL 规范化与 redirect（不假超时）', () => {
  it('裸域尾斜杠双向：tab 已是 https://host/ 时请求 https://host 走 reload', async () => {
    addTab({ id: 10, url: 'https://a.example/' });
    const pending = new NavigateTool().execute(
      { url: 'https://a.example', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(true);
    });
    fireUpdated(10, { status: 'loading' });
    fireUpdated(10, { status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(false);
  });

  it('路径尾斜杠不是裸域：tab /foo/ 请求 /foo 走 navigate 而非 reload', async () => {
    addTab({ id: 10, url: 'https://a.example/foo/' });
    const pending = new NavigateTool().execute(
      { url: 'https://a.example/foo', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://a.example/foo', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example/foo', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(false);
  });

  it('路径尾斜杠反向：tab /foo 请求 /foo/，complete 无 loading 也落地（不假超时）', async () => {
    // Chrome 把 /foo 规范化成 /foo/：若 samePageUrl 单向（actual===requested+'/'），
    // waitForLoad 把落地 url 当成「没离开 prevUrl」，错过 loading 就烧满 30s。
    addTab({ id: 10, url: 'https://a.example/foo' });
    const pending = new NavigateTool().execute(
      { url: 'https://a.example/foo/', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    addTab({ id: 10, url: 'https://a.example/foo/', status: 'complete' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example/foo/', status: 'complete' });
    const res = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r('LOAD_TIMEOUT'), 1000)),
    ]);
    expect(res).toMatchObject({ success: true, url: 'https://a.example/foo/' });
  });

  it('同文档锚点导航：Chrome 规范化裸域补斜杠，url-only 事件即算落地', async () => {
    addTab({ id: 10, url: 'https://a.example/' });
    const pending = new NavigateTool().execute(
      { url: 'https://a.example#section', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    // 真实 Chrome：同文档提交后 tab.url 变为规范化形式 https://a.example/#section，
    // onUpdated 只带 {url}，没有 status:'complete'。探测若要求字面相等永远不匹配。
    addTab({ id: 10, url: 'https://a.example/#section' });
    fireUpdated(10, { url: 'https://a.example/#section' });
    const res = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r('LOAD_TIMEOUT'), 1000)),
    ]);
    expect(res).toMatchObject({ success: true, url: 'https://a.example#section' });
  });

  it('新 tab 快速 301：加载在监听注册前完成，探测按「非空 complete」命中（不要求等于请求 url）', async () => {
    const origCreate = chrome.tabs.create;
    (chrome.tabs as { create: unknown }).create = (async (opts: { url?: string }) => {
      const tab = await origCreate(opts);
      // 301 在 attach/注册监听前已跳完：最终 url ≠ 请求 url，complete 事件已错过
      addTab({ id: tab.id!, url: 'https://final.example/', status: 'complete' });
      return tab;
    }) as typeof chrome.tabs.create;
    try {
      const res = await Promise.race([
        new NavigateTool().execute(
          { url: 'https://short.example', newTab: true, _tabId: 10, _tabIds: [10] },
          ctx,
        ),
        new Promise((r) => setTimeout(() => r('LOAD_TIMEOUT'), 1000)),
      ]);
      expect(res).toMatchObject({ success: true, url: 'https://short.example' });
    } finally {
      (chrome.tabs as { create: unknown }).create = origCreate;
    }
  });

  it('reuse 路径 navigate 后 301：url 偏离旧 url 的 loading→complete 即落地（终态 url 不等于请求 url）', async () => {
    addTab({ id: 10, url: 'https://a.example' });
    const pending = new NavigateTool().execute(
      { url: 'http://a.example/old', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    // 301 跳到 https://a.example/new：complete 事件带的是终态 url
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://a.example/new', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example/new', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('loading 事件在监听注册前送达（竞态）：探测按「url 已偏离」武装，complete 不被门禁吞掉', async () => {
    // 竞态窗口：Page.navigate 之后、waitForLoad 注册 onUpdated 之前，Chrome 已把 tab
    // 切到新 url 并开始 loading，但 loading 事件已在别处送达（没注册到）。
    // 探测看到「新 url + 仍在 loading」时必须武装门禁，否则随后不带 url 的
    // complete 被 armed 门禁吞掉，烧满 30s 假超时。
    addTab({ id: 10, url: 'https://a.example' });
    const stub = stubSendCommand({
      'Page.navigate': () => {
        // 模拟竞态：导航提交极快，url 已变、状态 loading，loading 事件已错过
        addTab({ id: 10, url: 'https://b.example', status: 'loading' });
        return { frameId: 'f1' };
      },
    });
    try {
      const pending = new NavigateTool().execute(
        { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
        ctx,
      );
      await vi.waitFor(() => {
        expect(stub.calls.some((c) => c.method === 'Page.navigate')).toBe(true);
      });
      // 等探测跑完（看到新 url + loading，不 resolve）
      await new Promise((r) => setTimeout(r, 50));
      fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
      const res = await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r('LOAD_TIMEOUT'), 2000)),
      ]);
      expect(res).toMatchObject({ success: true, url: 'https://b.example' });
    } finally {
      stub.restore();
    }
  });
});

describe('navigate reload 路径的事件区分', () => {
  it('旧加载仍在进行时 reload：旧加载的 complete 不得误当 reload 完成', async () => {
    // 慢页面重试场景：status 仍 loading，url 已是目标 url → sameUrl → reload 路径
    addTab({ id: 10, url: 'https://a.example', status: 'loading' });
    let settled = false;
    const pending = new NavigateTool()
      .execute({ url: 'https://a.example', _tabId: 10, _tabIds: [10] }, ctx)
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(true);
    });
    // 旧加载的 complete 在 reload 确认窗口内到达：不得当成 reload 完成
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example', status: 'complete' });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    // reload 真正开始（loading）然后完成
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://a.example', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('Page.reload 失败：等待用的监听器立即清理，不留悬空 promise', async () => {
    const stub = stubSendCommand({
      'Page.reload': () => {
        throw new Error('Debugger is not attached');
      },
    });
    try {
      const baseUp = updatedListenerCount();
      const baseRm = removedListenerCount();
      await expect(
        new NavigateTool().execute(
          { url: 'https://a.example', _tabId: 10, _tabIds: [10], _session: 's' },
          ctx,
        ),
      ).rejects.toThrow(/Debugger is not attached/);
      expect(updatedListenerCount()).toBe(baseUp);
      expect(removedListenerCount()).toBe(baseRm);
    } finally {
      stub.restore();
    }
  });
});

describe('navigate 探测出口与其它边界', () => {
  it('url 缺失 → 立刻报参数错误，不开 tab 不发 CDP', async () => {
    await expect(new NavigateTool().execute({ _tabId: 10, _tabIds: [10] }, ctx)).rejects.toThrow(
      /url is required/,
    );
    expect(debuggerCalls.length).toBe(0);
  });

  it('探测时 tab 已静默消失（onRemoved 未送达窗口）→ 探测失败即 stale_target', async () => {
    // tabs.get 探测在注册的监听之后：窗口内 tab 被关但 onRemoved 还没送达，
    // 探测的 rejection 必须归 stale_target，不得把裸错抛给调用方。
    const stub = stubSendCommand({
      'Page.navigate': () => {
        removeTabSilently(10);
        return { frameId: 'f1' };
      },
    });
    try {
      await expect(
        new NavigateTool().execute(
          { url: 'https://b.example', _tabId: 10, _tabIds: [10], _session: 's' },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'stale_target', details: { tabId: 10, session: 's' } });
    } finally {
      stub.restore();
    }
  });

  it('新建 tab 在 attach 前被静默移除 → attach 裸错归类 stale_target', async () => {
    const origCreate = chrome.tabs.create;
    (chrome.tabs as { create: unknown }).create = (async (opts: { url?: string }) => {
      const tab = await origCreate(opts);
      removeTabSilently(tab.id!); // create 返回后、attach 前的窗口内 tab 被关
      return tab;
    }) as typeof chrome.tabs.create;
    try {
      await expect(
        new NavigateTool().execute(
          { url: 'https://b.example', newTab: true, _tabId: 0, _tabIds: [], _session: 's' },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'stale_target' });
    } finally {
      (chrome.tabs as { create: unknown }).create = origCreate;
    }
  });

  it('其它 tab 的 complete 事件不影响本 tab 的等待', async () => {
    addTab({ id: 10, url: 'https://a.example', status: 'loading' });
    addTab({ id: 99, url: 'https://other.example' });
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // 其它 tab 完成加载：不得提前 resolve 本 tab 的 waitForLoad
    fireUpdated(99, { status: 'loading' }, { id: 99, url: 'https://other.example', status: 'loading' });
    fireUpdated(99, { status: 'complete' }, { id: 99, url: 'https://other.example', status: 'complete' });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://b.example', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('加载永不完成 → 30s 后报 page load timeout（兜底，不悬挂）', async () => {
    vi.useFakeTimers();
    try {
      addTab({ id: 10, url: 'https://a.example', status: 'loading' });
      const pending = new NavigateTool().execute(
        { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
        ctx,
      );
      const assertion = expect(pending).rejects.toThrow(/page load timeout/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('url-only 事件在 tab 仍 loading 时：武装但不 resolve，等随后的 complete', async () => {
    // 跨文档加载里的 redirect 跳：onUpdated 先带新 url（status 仍 loading），
    // 此轮只能武装不能命中；否则漏掉后续 complete 就烧满超时。
    addTab({ id: 10, url: 'https://a.example' });
    const pending = new NavigateTool().execute(
      { url: 'http://a.example/old', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // url 已跳走但仍在 loading：武装门禁，不 resolve
    fireUpdated(10, { url: 'https://a.example/new' }, { id: 10, url: 'https://a.example/new', status: 'loading' });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    // 随后不带 url 的 complete：armed=true → 命中
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://a.example/new', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('等待期间其它 tab 被关不影响本 tab 的等待', async () => {
    addTab({ id: 10, url: 'https://a.example', status: 'loading' });
    addTab({ id: 99, url: 'https://other.example' });
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // 其它 tab 被关：不得误报本 tab stale_target
    fireRemoved(99);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    fireUpdated(10, { status: 'loading' }, { id: 10, url: 'https://b.example', status: 'loading' });
    fireUpdated(10, { status: 'complete' }, { id: 10, url: 'https://b.example', status: 'complete' });
    await expect(pending).resolves.toMatchObject({ success: true });
  });
});

describe('navigate tab 死亡出口（协议 §3.3/§3.4 的 stale_target）', () => {
  it('reuse 路径：加载等待中 tab 被关 → 立刻 stale_target，不是 30s 误导性 timeout', async () => {
    addTab({ id: 10, url: 'https://a.example', status: 'loading' });
    const started = Date.now();
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10], _session: 's' },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 20));
    fireRemoved(10);
    await expect(pending).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reuse 路径：排队期间 tab 被关 → attach 裸错归类为 stale_target', async () => {
    const first = enqueueTab(10, async () => {
      fireRemoved(10);
    });
    const pending = new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10], _session: 's' },
      ctx,
    );
    await first;
    await expect(pending).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });
  });

  it('newTab:true 且 owned 当前 tab 已死 → stale_target（daemon 才能 ForgetTab，不得静默新建）', async () => {
    fireRemoved(10);
    await expect(
      new NavigateTool().execute(
        { url: 'https://b.example', newTab: true, _tabId: 10, _tabIds: [10], _session: 's' },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });
  });

  it('owned 当前 tab 已死且非 newTab → stale_target（原有语义保持）', async () => {
    fireRemoved(10);
    await expect(
      new NavigateTool().execute(
        { url: 'https://b.example', _tabId: 10, _tabIds: [10], _session: 's' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'stale_target' });
  });
});
