/**
 * upload 工具测试（协议 §4）：selector/files 必填校验、querySelector 未命中、
 * DOM.setFileInputFiles 参数与结果形状（含多文件）。sendCommand 局部分发，
 * afterEach 恢复共享 fake。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { UploadTool } = await import('./upload');

const ctx = { tabId: 10, documentEpoch: 1 };

let dispatch: (method: string, params: any) => any = () => ({});
const calls: { method: string; params: any }[] = [];
const origSendCommand = chrome.debugger.sendCommand;

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
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

/** 默认分发：getDocument 出 root，querySelector 命中 nodeId 42。 */
function uploadDispatch(nodeId = 42): (m: string, p: any) => any {
  return (m, p) => {
    if (m === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (m === 'DOM.querySelector') {
      expect(p.nodeId).toBe(1);
      return { nodeId };
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
      /selector is required/,
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
  it('querySelector 未命中（nodeId 0）→ element not found', async () => {
    dispatch = uploadDispatch(0);
    await expect(
      new UploadTool().execute({ selector: '#nope', files: ['/a.pdf'] }, ctx),
    ).rejects.toThrow(/element not found: #nope/);
    expect(calls.some((c) => c.method === 'DOM.setFileInputFiles')).toBe(false);
  });
});

describe('upload 成功路径', () => {
  it('单文件：setFileInputFiles 带文件路径与 nodeId', async () => {
    dispatch = uploadDispatch();
    const res = (await new UploadTool().execute(
      { selector: '#f', files: ['/tmp/a.pdf'] },
      ctx,
    )) as Record<string, unknown>;
    expect(setFilesParams()).toEqual({ files: ['/tmp/a.pdf'], nodeId: 42 });
    expect(res).toEqual({
      success: true,
      selector: '#f',
      fileCount: 1,
      files: ['/tmp/a.pdf'],
    });
  });

  it('多文件：fileCount 与 files 一致', async () => {
    dispatch = uploadDispatch();
    const res = (await new UploadTool().execute(
      { selector: '#f', files: ['/tmp/a.pdf', '/tmp/b.png'] },
      ctx,
    )) as Record<string, unknown>;
    expect(setFilesParams()).toEqual({ files: ['/tmp/a.pdf', '/tmp/b.png'], nodeId: 42 });
    expect(res).toMatchObject({ success: true, fileCount: 2 });
  });
});
