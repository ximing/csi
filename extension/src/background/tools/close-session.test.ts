/**
 * close_session 测试（协议 §3.4/§4）：
 * 只关 owned tab（按 _tabIds），已消失的 tab 计入 closed:0；
 * tabs.remove 不进 per-tab 队列——排在其它 session 长任务后面会撞
 * daemon CallTool 120s 超时（假失败 + 迟到的副作用）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireRemoved, installChrome, resetChromeState, tabsRemoved } from '../test-chrome';

installChrome();

const { CloseSessionTool } = await import('./close-session');
const { enqueueTab } = await import('../tab-queue');
const refs = await import('../refs');

const tool = new CloseSessionTool();
const ctx = { tabId: 0, documentEpoch: 0 };

interface CloseSessionResult {
  success: boolean;
  closed: number;
  remaining?: number[];
  code?: string;
}

describe('close_session', () => {
  beforeEach(() => {
    resetChromeState();
    refs.deleteTargetState(10);
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

  // 与 close_tab 的 close_failed 同语义：remove 失败先探测，tab 仍在（瞬时
  // 失败）→ 不得 dropTabQueue/deleteTargetState——活 tab 的队列尾被删会让
  // 在飞任务与新任务并发跑同一 tab。
  it('remove 瞬时失败（tab 仍在）→ closed:0 且保留 refs/queue 状态', async () => {
    addTab({ id: 10, url: 'https://a.example' });
    refs.assignRef(10, 111, 'button', 'A');
    const originalRemove = chrome.tabs.remove;
    (chrome.tabs as { remove: unknown }).remove = async () => {
      throw new Error('transient failure, tab still alive');
    };
    try {
      const result = (await tool.execute(
        { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
        ctx,
      )) as CloseSessionResult;
      expect(result).toEqual({
        success: true,
        closed: 0,
        remaining: [10],
        code: 'close_failed',
      });
    } finally {
      (chrome.tabs as { remove: unknown }).remove = originalRemove;
    }
    await expect(chrome.tabs.get(10)).resolves.toBeTruthy();
    expect(() => refs.consumeRef(10, 'click', '@e1')).not.toThrow();
  });

  it('remove 失败但 tab 已不在 → 按已关闭清理 refs（与 close_tab 的 already_closed 同语义）', async () => {
    addTab({ id: 10, url: 'https://a.example' });
    refs.assignRef(10, 111, 'button', 'A');
    fireRemoved(10); // 用户手动关掉，remove 将失败
    const result = (await tool.execute(
      { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
      ctx,
    )) as CloseSessionResult;
    expect(result).toEqual({ success: true, closed: 0 });
    expect(() => refs.consumeRef(10, 'click', '@e1')).toThrow(/unknown ref/);
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
