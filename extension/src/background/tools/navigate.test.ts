/**
 * navigate 工具层测试：成功路径同步 bump epoch（MV3 SW 丢 Page.frameNavigated
 * 时的兜底）；sameUrl 按任务执行时的当前 url 判定，不用排队前捕获的旧 url；
 * tab 在各阶段死亡一律快速 stale_target（协议 §3.3/§3.4），不出现误导性超时。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, fireRemoved, installChrome, resetChromeState } from '../test-chrome';

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
    const res = (await new NavigateTool().execute(
      { url: 'https://b.example', _tabId: 10, _tabIds: [10] },
      ctx,
    )) as { success: boolean; url: string };
    expect(res.success).toBe(true);
    expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
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
    const res = (await pending) as { success: boolean; url: string };
    expect(res.success).toBe(true);
    expect(debuggerCalls.some((c) => c.method === 'Page.reload')).toBe(true);
    expect(debuggerCalls.some((c) => c.method === 'Page.navigate')).toBe(false);
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
