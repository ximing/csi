/**
 * click @e 解析与 element.ts 同一路径：死 iframe 的 ref 抛 FRAME_GONE，
 * 过期 ref 抛 stale_ref ToolError（协议 §3.3）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { ClickTool } = await import('./click');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

describe('click @e 解析', () => {
  it('死 iframe 的 ref 抛 frame gone（与 element.ts 一致），不是通用 stale_ref', async () => {
    refs.assignRef(10, 111, 'button', 'A', 'child-frame-1');
    // fake DOM.resolveNode 返回 {} → 节点不可解析
    await expect(new ClickTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /frame is gone/,
    );
  });

  it('过期 ref 抛 stale_ref ToolError', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    refs.bumpEpoch(10, 'navigate');
    await expect(new ClickTool().execute({ selector: '@e1' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'stale_ref',
    });
  });
});
