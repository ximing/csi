/**
 * close_session 测试（协议 §3.4/§4.20）：
 * 只关 owned tab（按 _tabIds），已消失的 tab 计入 closed:0；
 * tabs.remove 不进 per-tab 队列——排在其它 session 长任务后面会撞
 * daemon CallTool 120s 超时（假失败 + 迟到的副作用）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState, tabsRemoved } from '../test-chrome';

installChrome();

const { CloseSessionTool } = await import('./close-session');
const { enqueueTab } = await import('../tab-queue');

const tool = new CloseSessionTool();
const ctx = { tabId: 0, documentEpoch: 0 };

interface CloseSessionResult {
  success: boolean;
  closed: number;
}

describe('close_session', () => {
  beforeEach(() => {
    resetChromeState();
  });

  it('closes all owned tabs and skips ones already gone', async () => {
    addTab({ id: 10, url: 'https://a.example' });
    addTab({ id: 11, url: 'https://b.example' });
    // 12 已不存在（如被用户手动关掉）
    const result = (await tool.execute(
      { _tabId: 10, _tabIds: [10, 11, 12], _borrowed: false, _session: 's' },
      ctx,
    )) as CloseSessionResult;
    expect(result).toEqual({ success: true, closed: 2 });
    expect([...tabsRemoved].sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('returns closed:0 when the session owns nothing (never touches borrowed tabs)', async () => {
    addTab({ id: 99, url: 'https://user.example' });
    const result = (await tool.execute(
      { _tabId: 99, _tabIds: [], _borrowed: true, _session: 's' },
      ctx,
    )) as CloseSessionResult;
    expect(result).toEqual({ success: true, closed: 0 });
    expect(tabsRemoved).toEqual([]);
    await expect(chrome.tabs.get(99)).resolves.toBeTruthy();
  });

  // 回归（#17 审查）：remove 不进 per-tab 队列。排在其它 session 的长任务
  // （wait 上限 120s）后面会撞 daemon CallTool 120s 超时——假失败 + 迟到的副作用。
  it("does not head-of-line block behind another session's long task", async () => {
    addTab({ id: 10, url: 'https://a.example' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const longTask = enqueueTab(10, () => blocked);
    try {
      const result = (await tool.execute(
        { _tabId: 0, _tabIds: [10], _borrowed: false, _session: 's' },
        ctx,
      )) as CloseSessionResult;
      expect(result).toEqual({ success: true, closed: 1 });
      expect(tabsRemoved).toEqual([10]);
    } finally {
      release();
      await longTask;
    }
  });
});
