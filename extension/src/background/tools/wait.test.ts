/**
 * wait 工具层测试（协议 §4 wait、§3.3 错误契约）：
 * 未知/过期 @e 立刻失败且带 code；poll 只吞「元素未找到」，ToolError 原样上抛；
 * gone:true 下节点已从文档移除算命中。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { WaitTool } = await import('./wait');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

describe('wait @e 错误契约', () => {
  it('未知 @e 立刻失败：ToolError unknown_ref', async () => {
    await expect(new WaitTool().execute({ selector: '@e9' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'unknown_ref',
    });
  });

  it('过期 @e 立刻失败：stale_ref 而不是全程超时', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    refs.bumpEpoch(10, 'navigate');
    await expect(new WaitTool().execute({ selector: '@e1' }, ctx)).rejects.toMatchObject({
      code: 'stale_ref',
    });
  });

  it('轮询中途导航：stale_ref 原样上抛，不被吞成 timeout', async () => {
    refs.assignRef(10, 111, 'button', 'A'); // fake DOM.resolveNode 返回 {} → 节点不可解析，持续未命中
    const pending = new WaitTool().execute(
      { selector: '@e1', timeout_ms: 2000, interval_ms: 50 },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 120));
    refs.bumpEpoch(10, 'navigate');
    await expect(pending).rejects.toMatchObject({ code: 'stale_ref' });
  });

  it('gone:true 且节点已从同文档移除 → 命中成功', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    const res = (await new WaitTool().execute(
      { selector: '@e1', gone: true, timeout_ms: 300, interval_ms: 50 },
      ctx,
    )) as { success: boolean; matched: string };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('gone:selector:@e1');
  });
});
