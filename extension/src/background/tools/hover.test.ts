/**
 * hover（协议 §4）单测：只发一条 mouseMoved（无 pressed/released）、
 * @e/CSS 两种解析路径、frame 参数与无盒错误分支。
 * chrome.debugger.sendCommand 在本文件局部覆写以回放盒模型与节点信息。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState, stubSendCommand } from '../test-chrome';

installChrome();

const { HoverTool } = await import('./hover');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };
// content 是交错的 [x,y,...] 四边形；此盒中心 (50.5, 51.5) → 四舍五入 (51, 52)。
const BOX = { model: { content: [0, 0, 101, 0, 101, 103, 0, 103] } };

let calls: { method: string; params: any }[] = [];
let restoreSend: (() => void) | undefined;

function stub(handlers: Record<string, (params: any) => unknown>): void {
  const s = stubSendCommand(handlers);
  calls = s.calls;
  restoreSend = s.restore;
}

afterEach(() => {
  restoreSend?.();
  restoreSend = undefined;
});

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

function mouseCalls(): any[] {
  return calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params);
}

describe('hover 参数校验', () => {
  it('缺 selector 抛错', async () => {
    await expect(new HoverTool().execute({}, ctx)).rejects.toThrow(
      'hover: selector is required (CSS selector or @e ref)',
    );
  });

  it('frame 非字符串抛错', async () => {
    await expect(new HoverTool().execute({ selector: '#a', frame: 3 }, ctx)).rejects.toThrow(
      'hover: frame must be a string',
    );
  });

  it('CSS 未命中抛 element not found', async () => {
    stub({ 'Runtime.evaluate': () => ({ result: {} }) });
    await expect(new HoverTool().execute({ selector: '#nope' }, ctx)).rejects.toThrow(
      'hover: element not found: #nope',
    );
  });
});

describe('hover trusted 事件序列', () => {
  it('CSS 命中：只发一条 mouseMoved，不发 pressed', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: { value: { tag: 'A', text: 'menu' } } }),
    });
    const res = (await new HoverTool().execute({ selector: '#item' }, ctx)) as any;
    expect(res).toEqual({ success: true, x: 51, y: 52, tag: 'A', text: 'menu' });
    expect(mouseCalls()).toEqual([
      { type: 'mouseMoved', x: 50.5, y: 51.5, button: 'none', buttons: 0 },
    ]);
    // 顺序：resolveObjectId(evaluate) → scrollIntoView(callFunctionOn) → getBoxModel。
    expect(calls.slice(0, 3).map((c) => c.method)).toEqual([
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'DOM.getBoxModel',
    ]);
    expect(calls[1]!.params.functionDeclaration).toContain("scrollIntoView({ block: 'center'");
  });

  it('节点信息缺省时 tag/text 兜底空串', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: {} }),
    });
    const res = (await new HoverTool().execute({ selector: '#item' }, ctx)) as any;
    expect(res.tag).toBe('');
    expect(res.text).toBe('');
  });
});

describe('hover 无盒错误', () => {
  it('DOM.getBoxModel 抛错 → NO_BOX_ERROR 包上 CDP 信息', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => {
        throw new Error('node is gone');
      },
    });
    await expect(new HoverTool().execute({ selector: '#item' }, ctx)).rejects.toThrow(
      /no layout box.*CDP: node is gone/,
    );
  });

  it('content 缺失或不足 8 个数 → NO_BOX_ERROR', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => ({ model: {} }),
    });
    await expect(new HoverTool().execute({ selector: '#item' }, ctx)).rejects.toThrow(/no layout box/);

    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => ({ model: { content: [0, 0, 100, 0] } }),
    });
    await expect(new HoverTool().execute({ selector: '#item' }, ctx)).rejects.toThrow(/no layout box/);
  });
});

describe('hover @e 路径', () => {
  it('ref 解析成功并忽略 frame 参数（ref 自带帧）', async () => {
    refs.assignRef(10, 111, 'menuitem', 'Open');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-9' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: { value: { tag: 'DIV', text: 'Open' } } }),
    });
    const res = (await new HoverTool().execute({ selector: '@e1', frame: 'whatever' }, ctx)) as any;
    expect(res.tag).toBe('DIV');
    // @e 带 frame 也不做帧发现。
    expect(calls.some((c) => c.method === 'Page.getFrameTree')).toBe(false);
    expect(calls[0]!.params.backendNodeId).toBe(111);
    expect(mouseCalls()).toHaveLength(1);
  });

  it('死 iframe 的 ref 抛 frame gone', async () => {
    refs.assignRef(10, 111, 'menuitem', 'A', 'child-frame-1');
    await expect(new HoverTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(/frame is gone/);
  });
});

describe('hover frame 参数（CSS）', () => {
  it('frame 走帧发现（无命中时报错），不静默落到顶层', async () => {
    stub({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'top', url: 'https://a.example' } },
      }),
    });
    await expect(new HoverTool().execute({ selector: '#item', frame: 'nope' }, ctx)).rejects.toThrow(
      'iframe: no frame matching "nope"',
    );
    expect(calls.some((c) => c.method === 'Page.getFrameTree')).toBe(true);
  });
});
