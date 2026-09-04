/**
 * mouse_click（协议 §4）单测：box-model 中心的 trusted 鼠标事件序列
 * （moved→pressed→released）、@e/CSS 两种解析路径、frame 参数与无盒错误分支。
 * chrome.debugger.sendCommand 在本文件局部覆写以回放盒模型与节点信息。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, resetChromeState, stubSendCommand } from '../test-chrome';

installChrome();

const { MouseClickTool } = await import('./mouse-click');
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

describe('mouse_click 参数校验', () => {
  it('缺 selector 抛错', async () => {
    await expect(new MouseClickTool().execute({}, ctx)).rejects.toThrow(
      'mouse_click: selector is required (CSS selector or @e ref)',
    );
  });

  it('frame 非字符串抛错', async () => {
    await expect(new MouseClickTool().execute({ selector: '#a', frame: 3 }, ctx)).rejects.toThrow(
      'mouse_click: frame must be a string',
    );
  });

  it('CSS 未命中抛 element not found', async () => {
    stub({ 'Runtime.evaluate': () => ({ result: {} }) });
    await expect(new MouseClickTool().execute({ selector: '#nope' }, ctx)).rejects.toThrow(
      'mouse_click: element not found: #nope',
    );
  });
});

describe('mouse_click trusted 事件序列', () => {
  it('CSS 命中：moved→pressed→released，坐标取盒中心并四舍五入', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: { value: { tag: 'BUTTON', text: 'Go' } } }),
    });
    const res = (await new MouseClickTool().execute({ selector: '#btn' }, ctx)) as any;
    expect(res).toEqual({ success: true, x: 51, y: 52, tag: 'BUTTON', text: 'Go' });
    expect(mouseCalls()).toEqual([
      { type: 'mouseMoved', x: 50.5, y: 51.5, button: 'none', buttons: 0 },
      { type: 'mousePressed', x: 50.5, y: 51.5, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 50.5, y: 51.5, button: 'left', buttons: 0, clickCount: 1 },
    ]);
    // 顺序：resolveObjectId(evaluate) → scrollIntoView(callFunctionOn) → getBoxModel。
    expect(calls.slice(0, 3).map((c) => c.method)).toEqual([
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'DOM.getBoxModel',
    ]);
    expect(calls[1]!.params.functionDeclaration).toContain("scrollIntoView({ block: 'center'");
    expect(calls[1]!.params.objectId).toBe('obj-1');
  });

  it('节点信息缺省时 tag/text 兜底空串', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: {} }),
    });
    const res = (await new MouseClickTool().execute({ selector: '#btn' }, ctx)) as any;
    expect(res.tag).toBe('');
    expect(res.text).toBe('');
  });
});

describe('mouse_click 无盒错误', () => {
  it('DOM.getBoxModel 抛错 → NO_BOX_ERROR 包上 CDP 信息', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => {
        throw new Error('node is gone');
      },
    });
    await expect(new MouseClickTool().execute({ selector: '#btn' }, ctx)).rejects.toThrow(
      /no layout box.*CDP: node is gone/,
    );
  });

  it('content 缺失 → NO_BOX_ERROR', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => ({ model: {} }),
    });
    await expect(new MouseClickTool().execute({ selector: '#btn' }, ctx)).rejects.toThrow(
      /no layout box/,
    );
  });

  it('content 不足 8 个数 → NO_BOX_ERROR', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { objectId: 'obj-1' } }),
      'DOM.getBoxModel': () => ({ model: { content: [0, 0, 100, 0] } }),
    });
    await expect(new MouseClickTool().execute({ selector: '#btn' }, ctx)).rejects.toThrow(
      /no layout box/,
    );
  });
});

describe('mouse_click @e 路径', () => {
  it('ref 解析成功并忽略 frame 参数（ref 自带帧）', async () => {
    refs.assignRef(10, 111, 'button', 'Go');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-9' } }),
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: { value: { tag: 'A', text: 'link' } } }),
    });
    const res = (await new MouseClickTool().execute({ selector: '@e1', frame: 'whatever' }, ctx)) as any;
    expect(res.tag).toBe('A');
    // @e 带 frame 也不做帧发现。
    expect(calls.some((c) => c.method === 'Page.getFrameTree')).toBe(false);
    expect(calls[0]!.params.backendNodeId).toBe(111);
    expect(mouseCalls()).toHaveLength(3);
  });

  it('死 iframe 的 ref 抛 frame gone', async () => {
    refs.assignRef(10, 111, 'button', 'A', 'child-frame-1');
    await expect(new MouseClickTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /frame is gone/,
    );
  });
});

describe('mouse_click frame 参数（CSS）', () => {
  function stubFrames(): void {
    stub({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'top', url: 'https://a.example', securityOrigin: 'https://a.example' },
          childFrames: [
            {
              frame: {
                id: 'child-1',
                parentId: 'top',
                url: 'https://a.example/embed',
                securityOrigin: 'https://a.example',
              },
            },
          ],
        },
      }),
      'Runtime.evaluate': (p: any) =>
        typeof p.expression === 'string' && p.expression.includes('iframe,frame')
          ? { result: { value: [{ src: 'https://a.example/embed', name: 'emb', sandbox: null, sameDoc: true }] } }
          : { result: { objectId: 'obj-2' } },
      'DOM.getBoxModel': () => BOX,
      'Runtime.callFunctionOn': () => ({ result: { value: { tag: 'INPUT', text: '' } } }),
    });
  }

  it('frame 命中子帧：querySelector 在该帧 contextId 里求值后照常点击', async () => {
    // 预置该帧的默认执行上下文，contextIdForFrame 直接命中缓存。
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 42, auxData: { frameId: 'child-1', isDefault: true } },
    });
    stubFrames();
    const res = (await new MouseClickTool().execute({ selector: '#btn', frame: 'embed' }, ctx)) as any;
    expect(res.success).toBe(true);
    const query = calls.find(
      (c) => c.method === 'Runtime.evaluate' && String(c.params.expression).startsWith('document.querySelector'),
    );
    expect(query!.params.contextId).toBe(42);
    expect(mouseCalls()).toHaveLength(3);
  });

  it('frame 无命中抛错', async () => {
    stubFrames();
    await expect(new MouseClickTool().execute({ selector: '#btn', frame: 'nope' }, ctx)).rejects.toThrow(
      'iframe: no frame matching "nope"',
    );
  });
});
