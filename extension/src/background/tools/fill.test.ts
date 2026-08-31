/**
 * fill @e 解析与 element.ts 同一路径：死 iframe 的 ref 抛 FRAME_GONE，
 * 不漂移成通用 stale_ref。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { FillTool } = await import('./fill');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

describe('fill @e 解析', () => {
  it('死 iframe 的 ref 抛 frame gone（与 element.ts 一致）', async () => {
    refs.assignRef(10, 111, 'textbox', 'A', 'child-frame-1');
    await expect(
      new FillTool().execute({ selector: '@e1', value: 'x' }, ctx),
    ).rejects.toThrow(/frame is gone/);
  });

  it('过期 ref 抛 stale_ref ToolError', async () => {
    refs.assignRef(10, 111, 'textbox', 'A');
    refs.bumpEpoch(10, 'navigate');
    await expect(
      new FillTool().execute({ selector: '@e1', value: 'x' }, ctx),
    ).rejects.toMatchObject({ name: 'ToolError', code: 'stale_ref' });
  });
});
