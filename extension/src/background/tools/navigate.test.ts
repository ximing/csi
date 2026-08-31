/**
 * navigate 工具层测试：成功路径同步 bump epoch（MV3 SW 丢 Page.frameNavigated
 * 时的兜底）；sameUrl 按任务执行时的当前 url 判定，不用排队前捕获的旧 url。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

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
