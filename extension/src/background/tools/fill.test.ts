/**
 * fill（协议 §4）单测：@e / CSS 两条路径（native setter 片段注入、
 * exceptionDetails、error 值、返回值缺省兜底）、frame 参数（@e 忽略、
 * CSS 命中子帧用该帧 contextId）。@e 解析与 element.ts 同一路径：
 * 死 iframe 的 ref 抛 FRAME_GONE，不漂移成通用 stale_ref。
 * chrome.debugger.sendCommand 在本文件局部覆写以回放求值结果。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, resetChromeState, stubSendCommand } from '../test-chrome';

installChrome();

const { FillTool } = await import('./fill');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

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

describe('fill 参数校验', () => {
  it('缺 selector / 缺 value 抛错', async () => {
    await expect(new FillTool().execute({ value: 'x' }, ctx)).rejects.toThrow(
      'fill: selector is required (CSS selector or @e ref)',
    );
    await expect(new FillTool().execute({ selector: '#a' }, ctx)).rejects.toThrow('fill: value is required');
  });

  it('frame 非字符串抛错', async () => {
    await expect(
      new FillTool().execute({ selector: '#a', value: 'x', frame: 7 }, ctx),
    ).rejects.toThrow('fill: frame must be a string');
  });
});

describe('fill @e 路径', () => {
  it('ref 填值：注入 native setter 片段并回传结果', async () => {
    refs.assignRef(10, 111, 'textbox', 'Q');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { success: true, tag: 'INPUT', mode: 'value' } } }),
    });
    const res = await new FillTool().execute({ selector: '@e1', value: 'hi' }, ctx);
    expect(res).toEqual({ success: true, tag: 'INPUT', mode: 'value' });
    const call = calls.find((c) => c.method === 'Runtime.callFunctionOn')!;
    expect(call.params.objectId).toBe('obj-1');
    expect(call.params.functionDeclaration).toContain('__target.focus()');
    expect(call.params.functionDeclaration).toContain('__nativeSetter');
    // 值经 JSON 序列化嵌进片段。
    expect(call.params.functionDeclaration).toContain('"hi"');
  });

  it('页面片段抛异常 → fill: <text>', async () => {
    refs.assignRef(10, 111, 'textbox', 'Q');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ exceptionDetails: { text: 'boom' } }),
    });
    await expect(new FillTool().execute({ selector: '@e1', value: 'x' }, ctx)).rejects.toThrow(
      'fill: boom',
    );
  });

  it('片段无返回值时兜底 { success: true }', async () => {
    refs.assignRef(10, 111, 'textbox', 'Q');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: {} }),
    });
    await expect(new FillTool().execute({ selector: '@e1', value: 'x' }, ctx)).resolves.toEqual({
      success: true,
    });
  });

  it('@e 忽略 frame 参数（ref 自带帧，不做帧发现）', async () => {
    refs.assignRef(10, 111, 'textbox', 'Q');
    stub({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { success: true, tag: 'INPUT', mode: 'value' } } }),
    });
    await new FillTool().execute({ selector: '@e1', value: 'x', frame: 'whatever' }, ctx);
    expect(calls.some((c) => c.method === 'Page.getFrameTree')).toBe(false);
  });

  it('死 iframe 的 ref 抛 frame gone（与 element.ts 一致），不是通用 stale_ref', async () => {
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

describe('fill CSS 路径', () => {
  it('选择器命中：注入 querySelector + native setter 片段', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { value: { success: true, tag: 'TEXTAREA', mode: 'value' } } }),
    });
    const res = await new FillTool().execute({ selector: '#q', value: 'yo' }, ctx);
    expect(res).toEqual({ success: true, tag: 'TEXTAREA', mode: 'value' });
    const call = calls.find((c) => c.method === 'Runtime.evaluate')!;
    expect(call.params.expression).toContain('document.querySelector("#q")');
    expect(call.params.expression).toContain('__nativeSetter');
    expect(call.params.expression).toContain('"yo"');
    expect(call.params.returnByValue).toBe(true);
    expect(call.params.awaitPromise).toBe(false);
    expect('contextId' in call.params).toBe(false);
  });

  it('元素不存在：片段返回 error 值 → 原样抛出', async () => {
    stub({
      'Runtime.evaluate': () => ({ result: { value: { error: 'fill: element not found: #q' } } }),
    });
    await expect(new FillTool().execute({ selector: '#q', value: 'x' }, ctx)).rejects.toThrow(
      'fill: element not found: #q',
    );
  });

  it('求值异常 → fill: <text>', async () => {
    stub({ 'Runtime.evaluate': () => ({ exceptionDetails: { text: 'bad ctx' } }) });
    await expect(new FillTool().execute({ selector: '#q', value: 'x' }, ctx)).rejects.toThrow(
      'fill: bad ctx',
    );
  });

  it('返回值缺省时兜底 { success: true }', async () => {
    stub({ 'Runtime.evaluate': () => ({ result: {} }) });
    await expect(new FillTool().execute({ selector: '#q', value: 'x' }, ctx)).resolves.toEqual({
      success: true,
    });
  });

  it('frame 命中子帧：填值求值带该帧 contextId', async () => {
    // 预置 child-1 帧的默认执行上下文，contextIdForFrame 直接命中缓存。
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 42, auxData: { frameId: 'child-1', isDefault: true } },
    });
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
          : { result: { value: { success: true, tag: 'INPUT', mode: 'value' } } },
    });
    const res = await new FillTool().execute({ selector: '#q', value: 'x', frame: 'embed' }, ctx);
    expect(res).toEqual({ success: true, tag: 'INPUT', mode: 'value' });
    // 帧发现自身的 iframe 枚举不带 contextId；填值求值才带。
    const fillCall = calls.find(
      (c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('__nativeSetter'),
    )!;
    expect(fillCall.params.contextId).toBe(42);
  });

  it('frame 无命中抛错', async () => {
    stub({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'top', url: 'https://a.example' } },
      }),
    });
    await expect(new FillTool().execute({ selector: '#q', value: 'x', frame: 'nope' }, ctx)).rejects.toThrow(
      'iframe: no frame matching "nope"',
    );
  });
});
