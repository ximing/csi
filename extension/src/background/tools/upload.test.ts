/**
 * upload 工具测试（协议 §4）：selector/files 必填校验、CSS 未命中、
 * @e / CSS 两条解析路径、DOM.setFileInputFiles 参数与结果形状（含多文件）。
 * sendCommand 局部分发，afterEach 恢复共享 fake。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { UploadTool } = await import('./upload');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

let dispatch: (method: string, params: any) => any = () => ({});
const calls: { method: string; params: any }[] = [];
const origSendCommand = chrome.debugger.sendCommand;

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
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

/** CSS 路径：Runtime.evaluate querySelector（element.ts objectIdFromCss）。null = 未命中。 */
function cssDispatch(objectId: string | null = 'obj-css'): (m: string, p: any) => any {
  return (m, p) => {
    if (m === 'Runtime.evaluate') {
      expect(String(p.expression)).toContain('document.querySelector');
      expect(p.returnByValue).toBe(false);
      if (!objectId) return { result: { subtype: 'null' } };
      return { result: { objectId } };
    }
    return {};
  };
}

function setFilesParams(): any {
  return calls.find((c) => c.method === 'DOM.setFileInputFiles')?.params;
}

describe('upload 参数校验', () => {
  it('缺 selector 报错', async () => {
    await expect(new UploadTool().execute({ files: ['/a.pdf'] }, ctx)).rejects.toThrow(
      'upload: selector is required (CSS selector or @e ref)',
    );
  });

  it('缺 files 报错', async () => {
    await expect(new UploadTool().execute({ selector: '#f' }, ctx)).rejects.toThrow(
      /files is required/,
    );
  });

  it('files 非数组报错', async () => {
    await expect(
      new UploadTool().execute({ selector: '#f', files: '/a.pdf' }, ctx),
    ).rejects.toThrow(/files is required/);
  });

  it('files 空数组报错', async () => {
    await expect(
      new UploadTool().execute({ selector: '#f', files: [] }, ctx),
    ).rejects.toThrow(/files is required/);
  });
});

describe('upload 元素解析', () => {
  it('CSS 未命中 → element not found', async () => {
    dispatch = cssDispatch(null);
    await expect(
      new UploadTool().execute({ selector: '#nope', files: ['/a.pdf'] }, ctx),
    ).rejects.toThrow('upload: element not found: #nope');
    expect(calls.some((c) => c.method === 'DOM.setFileInputFiles')).toBe(false);
    expect(calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
  });
});

describe('upload @e 路径', () => {
  it('ref 命中：setFileInputFiles 带 objectId，不走 querySelector', async () => {
    refs.assignRef(10, 111, 'textbox', 'Upload');
    dispatch = (m, p) => {
      if (m === 'DOM.resolveNode') {
        expect(p.backendNodeId).toBe(111);
        return { object: { objectId: 'obj-1' } };
      }
      return {};
    };
    const res = (await new UploadTool().execute(
      { selector: '@e1', files: ['/tmp/a.pdf'] },
      ctx,
    )) as Record<string, unknown>;
    expect(setFilesParams()).toEqual({ files: ['/tmp/a.pdf'], objectId: 'obj-1' });
    expect(calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
    expect(calls.some((c) => c.method === 'DOM.getDocument')).toBe(false);
    expect(res).toEqual({
      success: true,
      selector: '@e1',
      fileCount: 1,
      files: ['/tmp/a.pdf'],
    });
  });

  it('死 iframe 的 ref 抛 frame gone（与 element.ts 一致），不是通用 stale_ref', async () => {
    refs.assignRef(10, 111, 'textbox', 'A', 'child-frame-1');
    await expect(
      new UploadTool().execute({ selector: '@e1', files: ['/a.pdf'] }, ctx),
    ).rejects.toThrow(/frame is gone/);
  });

  it('过期 ref 抛 stale_ref ToolError', async () => {
    refs.assignRef(10, 111, 'textbox', 'A');
    refs.bumpEpoch(10, 'navigate');
    await expect(
      new UploadTool().execute({ selector: '@e1', files: ['/a.pdf'] }, ctx),
    ).rejects.toMatchObject({ name: 'ToolError', code: 'stale_ref' });
  });
});

describe('upload 成功路径', () => {
  it('单文件 CSS：setFileInputFiles 带文件路径与 objectId', async () => {
    dispatch = cssDispatch();
    const res = (await new UploadTool().execute(
      { selector: '#f', files: ['/tmp/a.pdf'] },
      ctx,
    )) as Record<string, unknown>;
    expect(setFilesParams()).toEqual({ files: ['/tmp/a.pdf'], objectId: 'obj-css' });
    expect(calls.some((c) => c.method === 'DOM.querySelector')).toBe(false);
    expect(calls.find((c) => c.method === 'Runtime.evaluate')!.params.expression).toBe(
      'document.querySelector("#f")',
    );
    expect(res).toEqual({
      success: true,
      selector: '#f',
      fileCount: 1,
      files: ['/tmp/a.pdf'],
    });
  });

  it('多文件：fileCount 与 files 一致', async () => {
    dispatch = cssDispatch();
    const res = (await new UploadTool().execute(
      { selector: '#f', files: ['/tmp/a.pdf', '/tmp/b.png'] },
      ctx,
    )) as Record<string, unknown>;
    expect(setFilesParams()).toEqual({
      files: ['/tmp/a.pdf', '/tmp/b.png'],
      objectId: 'obj-css',
    });
    expect(res).toMatchObject({ success: true, fileCount: 2 });
  });
});
