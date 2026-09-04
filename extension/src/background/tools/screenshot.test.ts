/**
 * screenshot 工具测试（协议 §4）：format/quality 默认值、fullPage 与 selector
 * 互斥、selector 裁剪（boxModel 各失败形态）、fullPage+frame 的 getFrameOwner→
 * resolveNode 裁剪路径、captureBeyondViewport 及其失败重写。sendCommand 按方法
 * 局部分发，afterEach 恢复共享 fake。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTab,
  debuggerCalls,
  fireDebuggerEvent,
  installChrome,
  resetChromeState,
} from '../test-chrome';

installChrome();

const { ScreenshotTool } = await import('./screenshot');
const refs = await import('../refs');
const frames = await import('../frames');

const ctx = { tabId: 10, documentEpoch: 1 };

/** 同一 top 域下的子帧 f1（非 isolated），供 frame 解析走通。 */
const FRAME_TREE = {
  frameTree: {
    frame: { id: 'top', url: 'https://a.example/', securityOrigin: 'https://a.example' },
    childFrames: [
      { frame: { id: 'f1', parentId: 'top', url: 'https://a.example/embed', securityOrigin: 'https://a.example' } },
    ],
  },
};

// 100x50 的 border quad（x:10..110, y:20..70）
const GOOD_BORDER = [10, 20, 110, 20, 110, 70, 10, 70];
// 全部同 x/y 的退化 quad → 零尺寸
const ZERO_BORDER = [10, 20, 10, 20, 10, 20, 10, 20];

let dispatch: (method: string, params: any) => any = () => ({});
const calls: { method: string; params: any }[] = [];
const origSendCommand = chrome.debugger.sendCommand;

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
  frames.clearContextsForTab(10);
  calls.length = 0;
  dispatch = () => ({});
  chrome.debugger.sendCommand = (async (debuggee: { tabId: number }, method: string, params?: object) => {
    debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
    calls.push({ method, params });
    return dispatch(method, params);
  }) as typeof chrome.debugger.sendCommand;
});

afterEach(() => {
  chrome.debugger.sendCommand = origSendCommand;
});

function captureParams(): any {
  return calls.find((c) => c.method === 'Page.captureScreenshot')?.params;
}

describe('screenshot 参数与默认值', () => {
  it('无参：png、无 quality/clip/captureBeyondViewport', async () => {
    dispatch = (m) => (m === 'Page.captureScreenshot' ? { data: 'abc123' } : {});
    const res = (await new ScreenshotTool().execute({}, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ format: 'png', dataLength: 6, data: 'abc123' });
    expect(captureParams()).toEqual({ format: 'png' });
  });

  it('jpeg 默认 quality 80', async () => {
    dispatch = (m) => (m === 'Page.captureScreenshot' ? { data: 'x' } : {});
    await new ScreenshotTool().execute({ format: 'jpeg' }, ctx);
    expect(captureParams()).toEqual({ format: 'jpeg', quality: 80 });
  });

  it('jpeg 显式 quality 生效', async () => {
    dispatch = (m) => (m === 'Page.captureScreenshot' ? { data: 'x' } : {});
    await new ScreenshotTool().execute({ format: 'jpeg', quality: 50 }, ctx);
    expect(captureParams()).toEqual({ format: 'jpeg', quality: 50 });
  });

  it('非 jpeg 时 quality 被忽略', async () => {
    dispatch = (m) => (m === 'Page.captureScreenshot' ? { data: 'x' } : {});
    await new ScreenshotTool().execute({ format: 'png', quality: 50 }, ctx);
    expect(captureParams()).toEqual({ format: 'png' });
  });

  it('fullPage 与 selector 互斥', async () => {
    await expect(
      new ScreenshotTool().execute({ selector: '#a', fullPage: true }, ctx),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('frame 参数非字符串报错', async () => {
    await expect(new ScreenshotTool().execute({ frame: 123 }, ctx)).rejects.toThrow(
      /frame must be a string/,
    );
  });
});

describe('screenshot selector 裁剪', () => {
  function selectorDispatch(border?: number[] | Error): (m: string, p: any) => any {
    return (m, p) => {
      if (m === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (m === 'DOM.getBoxModel') {
        if (border instanceof Error) throw border;
        return border === undefined ? {} : { model: { border } };
      }
      if (m === 'Page.captureScreenshot') return { data: 'clipdata' };
      if (m === 'Runtime.evaluate' && String(p.expression).includes('querySelectorAll')) {
        return { result: { value: [] } };
      }
      return {};
    };
  }

  it('@e ref：resolveNode + scrollIntoView + boxModel → clip 截图', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch(GOOD_BORDER);
    const res = (await new ScreenshotTool().execute({ selector: '@e1' }, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ format: 'png', data: 'clipdata', dataLength: 8 });
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
    expect(captureParams()).toEqual({
      format: 'png',
      clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 },
    });
  });

  it('@e ref 自带帧，frame 参数被忽略（不解析帧树）', async () => {
    refs.assignRef(10, 111, 'button', 'A', 'f1');
    dispatch = selectorDispatch(GOOD_BORDER);
    await new ScreenshotTool().execute({ selector: '@e1', frame: 'f1' }, ctx);
    expect(calls.some((c) => c.method === 'Page.getFrameTree')).toBe(false);
  });

  it('CSS + frame：解析帧 + 子帧 contextId 里 querySelector', async () => {
    // 预先注入 f1 的 default-world contextId，绕过 Runtime.enable 等待
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 7, auxData: { frameId: 'f1', isDefault: true } },
    });
    dispatch = (m, p) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'Runtime.evaluate') {
        const expr = String(p.expression ?? '');
        if (expr.includes('querySelectorAll')) return { result: { value: [] } };
        if (expr.includes('document.querySelector')) {
          expect(p.contextId).toBe(7);
          return { result: { objectId: 'obj-ctx' } };
        }
        return {};
      }
      if (m === 'DOM.getBoxModel') return { model: { border: GOOD_BORDER } };
      if (m === 'Page.captureScreenshot') return { data: 'frameclip' };
      return {};
    };
    const res = (await new ScreenshotTool().execute(
      { selector: '#inner', frame: 'f1' },
      ctx,
    )) as Record<string, unknown>;
    expect(res).toMatchObject({ data: 'frameclip' });
    expect(captureParams()).toMatchObject({
      clip: { x: 10, y: 20, width: 100, height: 50 },
    });
  });

  it('boxModel CDP 报错 → no layout box 且带 CDP 消息', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch(new Error('node is detached'));
    await expect(new ScreenshotTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /no layout box.*CDP: node is detached/,
    );
  });

  it('boxModel 无 border → no layout box', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch(undefined);
    await expect(new ScreenshotTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /no layout box/,
    );
  });

  it('border 少于 8 个数 → no layout box', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch([1, 2, 3, 4]);
    await expect(new ScreenshotTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /no layout box/,
    );
  });

  it('零尺寸 box → zero-size 错误', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch(ZERO_BORDER);
    await expect(new ScreenshotTool().execute({ selector: '@e1' }, ctx)).rejects.toThrow(
      /zero-size box \(width=0, height=0\)/,
    );
  });

  it('jpeg + selector 也带 quality', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    dispatch = selectorDispatch(GOOD_BORDER);
    await new ScreenshotTool().execute({ selector: '@e1', format: 'jpeg', quality: 30 }, ctx);
    expect(captureParams()).toMatchObject({ format: 'jpeg', quality: 30 });
  });
});

describe('screenshot fullPage（无 selector）', () => {
  it('成功：captureBeyondViewport=true', async () => {
    dispatch = (m) => (m === 'Page.captureScreenshot' ? { data: 'full' } : {});
    const res = (await new ScreenshotTool().execute({ fullPage: true }, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ data: 'full' });
    expect(captureParams()).toEqual({ format: 'png', captureBeyondViewport: true });
  });

  it('失败：重写为带建议的错误', async () => {
    dispatch = () => {
      throw new Error('capture failed');
    };
    await expect(new ScreenshotTool().execute({ fullPage: true }, ctx)).rejects.toThrow(
      /fullPage failed \(capture failed\).*try selector/,
    );
  });

  it('非 fullPage 失败：原样抛出 CDP 错误', async () => {
    dispatch = () => {
      throw new Error('raw-cdp-error');
    };
    await expect(new ScreenshotTool().execute({}, ctx)).rejects.toThrow('raw-cdp-error');
  });
});

describe('screenshot fullPage + frame（clip 到 iframe 可见盒，协议 §4.1）', () => {
  function frameDispatch(extra: Record<string, unknown> = {}): (m: string) => any {
    return (m) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (m === 'DOM.resolveNode') return { object: { objectId: 'frame-obj' } };
      if (m === 'DOM.getBoxModel') return { model: { border: GOOD_BORDER } };
      if (m === 'Page.captureScreenshot') return { data: 'framefull' };
      if (m === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    };
  }

  it('成功：getFrameOwner→resolveNode→boxModel，不开 captureBeyondViewport', async () => {
    dispatch = frameDispatch();
    const res = (await new ScreenshotTool().execute(
      { fullPage: true, frame: 'f1' },
      ctx,
    )) as Record<string, unknown>;
    expect(res).toMatchObject({ data: 'framefull' });
    const owner = calls.find((c) => c.method === 'DOM.getFrameOwner');
    expect(owner?.params).toEqual({ frameId: 'f1' });
    expect(captureParams()).toEqual({
      format: 'png',
      clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 },
    });
  });

  it('resolveNode 拿不到 objectId → FRAME_GONE', async () => {
    dispatch = (m) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (m === 'DOM.resolveNode') return {};
      if (m === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    };
    await expect(
      new ScreenshotTool().execute({ fullPage: true, frame: 'f1' }, ctx),
    ).rejects.toThrow(/frame is gone/);
  });

  it('boxModel CDP 报错 → no layout box 且带 CDP 消息', async () => {
    dispatch = (m) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (m === 'DOM.resolveNode') return { object: { objectId: 'frame-obj' } };
      if (m === 'DOM.getBoxModel') throw new Error('no box');
      if (m === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    };
    await expect(
      new ScreenshotTool().execute({ fullPage: true, frame: 'f1' }, ctx),
    ).rejects.toThrow(/no layout box.*CDP: no box/);
  });

  it('boxModel 无 border → no layout box', async () => {
    dispatch = (m) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (m === 'DOM.resolveNode') return { object: { objectId: 'frame-obj' } };
      if (m === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    };
    await expect(
      new ScreenshotTool().execute({ fullPage: true, frame: 'f1' }, ctx),
    ).rejects.toThrow(/no layout box/);
  });

  it('零尺寸 box → zero-size 错误', async () => {
    dispatch = (m) => {
      if (m === 'Page.getFrameTree') return FRAME_TREE;
      if (m === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (m === 'DOM.resolveNode') return { object: { objectId: 'frame-obj' } };
      if (m === 'DOM.getBoxModel') return { model: { border: ZERO_BORDER } };
      if (m === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    };
    await expect(
      new ScreenshotTool().execute({ fullPage: true, frame: 'f1' }, ctx),
    ).rejects.toThrow(/zero-size box/);
  });

  it('jpeg + fullPage + frame 也带 quality', async () => {
    dispatch = frameDispatch();
    await new ScreenshotTool().execute(
      { fullPage: true, frame: 'f1', format: 'jpeg' },
      ctx,
    );
    expect(captureParams()).toMatchObject({ format: 'jpeg', quality: 80 });
  });
});
