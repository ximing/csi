/**
 * close_tab 测试（协议 §3.4/§4.19）：
 * closed:false 的三个机器可读 code 分支 —— not_owned / already_closed /
 * close_failed，daemon 只对 already_closed 对账移除。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireRemoved, installChrome, resetChromeState, tabsRemoved } from '../test-chrome';

installChrome();

const { CloseTabTool } = await import('./close-tab');
const { enqueueTab } = await import('../tab-queue');

const tool = new CloseTabTool();
const ctx = { tabId: 10, documentEpoch: 1 };

interface CloseResult {
  success: boolean;
  closed: boolean;
  code?: string;
  reason?: string;
}

describe('close_tab', () => {
  beforeEach(() => {
    resetChromeState();
  });

  it('returns not_owned when the session has no current tab', async () => {
    const result = (await tool.execute(
      { _tabId: 0, _tabIds: [], _borrowed: false, _session: 's' },
      ctx,
    )) as CloseResult;
    expect(result.closed).toBe(false);
    expect(result.code).toBe('not_owned');
    expect(tabsRemoved).toEqual([]);
  });

  it('returns not_owned for a borrowed target and does not touch the user tab', async () => {
    addTab({ id: 99, url: 'https://user.example' });
    const result = (await tool.execute(
      { _tabId: 99, _tabIds: [10], _borrowed: true, _session: 's' },
      ctx,
    )) as CloseResult;
    expect(result.closed).toBe(false);
    expect(result.code).toBe('not_owned');
    expect(result.reason).toContain('borrowed');
    expect(tabsRemoved).toEqual([]);
    await expect(chrome.tabs.get(99)).resolves.toBeTruthy();
  });

  it('closes an owned tab', async () => {
    addTab({ id: 10, url: 'https://owned.example' });
    const result = (await tool.execute(
      { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
      ctx,
    )) as CloseResult;
    expect(result).toEqual({ success: true, closed: true });
    expect(tabsRemoved).toEqual([10]);
  });

  it('reports already_closed when the tab is already gone', async () => {
    addTab({ id: 10, url: 'https://owned.example' });
    fireRemoved(10); // 用户手动关掉：remove 与复查的 get 都会拒绝
    const result = (await tool.execute(
      { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
      ctx,
    )) as CloseResult;
    expect(result.closed).toBe(false);
    expect(result.code).toBe('already_closed');
  });

  // 回归（#17 审查）：remove 不进 per-tab 队列。排在其它 session 的长任务
  // （wait 上限 120s）后面会撞 daemon CallTool 120s 超时——假失败 + 迟到的副作用。
  it("does not head-of-line block behind another session's long task", async () => {
    addTab({ id: 10, url: 'https://owned.example' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const longTask = enqueueTab(10, () => blocked);
    try {
      const result = (await tool.execute(
        { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
        ctx,
      )) as CloseResult;
      expect(result).toEqual({ success: true, closed: true });
      expect(tabsRemoved).toEqual([10]);
    } finally {
      release();
      await longTask;
    }
  });

  it('reports close_failed when remove fails but the tab is still open', async () => {
    addTab({ id: 10, url: 'https://owned.example' });
    const original = chrome.tabs.remove;
    chrome.tabs.remove = (async () => {
      throw new Error('transient failure');
    }) as typeof chrome.tabs.remove;
    try {
      const result = (await tool.execute(
        { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
        ctx,
      )) as CloseResult;
      expect(result.closed).toBe(false);
      expect(result.code).toBe('close_failed');
      expect(result.reason).toContain('transient failure');
    } finally {
      chrome.tabs.remove = original;
    }
    // tab 必须仍在——daemon 不得因这次失败把它移出 owned 集
    expect(tabsRemoved).toEqual([]);
    await expect(chrome.tabs.get(10)).resolves.toBeTruthy();
  });
});
