/**
 * save_as_pdf 工具测试（协议 §4）：纸张格式表（含大小写与未知回退）、
 * scale 边界、printBackground/landscape 透传、printToPDF 无 data、
 * 标题读取成功/失败。sendCommand 局部分发，afterEach 恢复共享 fake。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { SaveAsPdfTool } = await import('./save-as-pdf');

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

/** 默认分发：printToPDF 出 base64，标题 evaluate 出 'Page Title'。 */
function pdfDispatch(overrides: Record<string, (params: any) => any> = {}): (m: string, p: any) => any {
  return (m, p) => {
    const override = overrides[m];
    if (override) return override(p);
    if (m === 'Page.printToPDF') return { data: 'QkFTRTY0' };
    if (m === 'Runtime.evaluate') return { result: { value: 'Page Title' } };
    return {};
  };
}

function printParams(): any {
  const prints = calls.filter((c) => c.method === 'Page.printToPDF');
  return prints[prints.length - 1]?.params;
}

describe('save_as_pdf 纸张格式', () => {
  const cases: [string, number, number][] = [
    ['letter', 8.5, 11],
    ['legal', 8.5, 14],
    ['a4', 8.27, 11.69],
    ['a3', 11.69, 16.54],
    ['tabloid', 11, 17],
  ];
  for (const [format, w, h] of cases) {
    it(`${format} → ${w}x${h} 英寸`, async () => {
      dispatch = pdfDispatch();
      await new SaveAsPdfTool().execute({ paper_format: format }, ctx);
      expect(printParams()).toMatchObject({ paperWidth: w, paperHeight: h, preferCSSPageSize: true });
    });
  }

  it('大写 paper_format 归一化（A4 → a4）', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ paper_format: 'A4' }, ctx);
    expect(printParams()).toMatchObject({ paperWidth: 8.27, paperHeight: 11.69 });
  });

  it('未知 paper_format 回退 letter', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ paper_format: 'bizarro' }, ctx);
    expect(printParams()).toMatchObject({ paperWidth: 8.5, paperHeight: 11 });
  });
});

describe('save_as_pdf scale 与布尔参数', () => {
  it('默认 scale 1、printBackground true、landscape false', async () => {
    dispatch = pdfDispatch();
    const res = (await new SaveAsPdfTool().execute({}, ctx)) as Record<string, unknown>;
    expect(printParams()).toMatchObject({ scale: 1, printBackground: true, landscape: false });
    expect(res).toMatchObject({
      data: 'QkFTRTY0',
      mimeType: 'application/pdf',
      dataLength: 8,
      pageTitle: 'Page Title',
      requestedFileName: '',
    });
  });

  it('scale 合法区间端点 0.1 / 2 都放行', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ scale: 0.1 }, ctx);
    expect(printParams()).toMatchObject({ scale: 0.1 });
    await new SaveAsPdfTool().execute({ scale: 2 }, ctx);
    expect(printParams()).toMatchObject({ scale: 2 });
  });

  it('scale 低于 0.1 报错', async () => {
    await expect(new SaveAsPdfTool().execute({ scale: 0.05 }, ctx)).rejects.toThrow(
      /scale must be in \[0.1, 2.0\], got 0.05/,
    );
  });

  it('scale 高于 2 报错', async () => {
    await expect(new SaveAsPdfTool().execute({ scale: 2.1 }, ctx)).rejects.toThrow(
      /scale must be in \[0.1, 2.0\], got 2.1/,
    );
  });

  it('scale 非数字按默认 1 处理', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ scale: 'big' }, ctx);
    expect(printParams()).toMatchObject({ scale: 1 });
  });

  it('print_background=false 关闭背景，其余真值保持开启', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ print_background: false }, ctx);
    expect(printParams()).toMatchObject({ printBackground: false });
    await new SaveAsPdfTool().execute({ print_background: true }, ctx);
    expect(printParams()).toMatchObject({ printBackground: true });
  });

  it('landscape=true 透传', async () => {
    dispatch = pdfDispatch();
    await new SaveAsPdfTool().execute({ landscape: true }, ctx);
    expect(printParams()).toMatchObject({ landscape: true });
  });
});

describe('save_as_pdf 结果组装', () => {
  it('printToPDF 返回无 data → 报错', async () => {
    dispatch = pdfDispatch({ 'Page.printToPDF': () => ({}) });
    await expect(new SaveAsPdfTool().execute({}, ctx)).rejects.toThrow(
      /CDP Page.printToPDF returned no data/,
    );
  });

  it('标题 evaluate 失败 → pageTitle 空串（标题只是装饰）', async () => {
    dispatch = pdfDispatch({
      'Runtime.evaluate': () => {
        throw new Error('ctx destroyed');
      },
    });
    const res = (await new SaveAsPdfTool().execute({}, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ data: 'QkFTRTY0', pageTitle: '' });
  });

  it('标题 evaluate 无 value → pageTitle 空串', async () => {
    dispatch = pdfDispatch({ 'Runtime.evaluate': () => ({ result: {} }) });
    const res = (await new SaveAsPdfTool().execute({}, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ pageTitle: '' });
  });

  it('file_name 透传到 requestedFileName', async () => {
    dispatch = pdfDispatch();
    const res = (await new SaveAsPdfTool().execute({ file_name: 'report.pdf' }, ctx)) as Record<string, unknown>;
    expect(res).toMatchObject({ requestedFileName: 'report.pdf' });
  });
});
