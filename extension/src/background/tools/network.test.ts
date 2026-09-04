/**
 * network 的结果预算测试（协议 §4.5）：
 * 每 tab 2000 条 ring buffer + droppedCount、list 的 limit/cursor 分页、
 * detail 的 body_mode=preview|file|full。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { NetworkTool, resetNetworkState } = await import('./network');

const tool = new NetworkTool();
const ctx = { tabId: 10, documentEpoch: 1 };

function exec(args: Record<string, unknown>): Promise<unknown> {
  return tool.execute(args, ctx);
}

interface ListPage {
  requests: { requestId: string; url?: string }[];
  nextCursor?: string;
  droppedCount: number;
}

async function list(args: Record<string, unknown> = {}): Promise<ListPage> {
  return (await exec({ cmd: 'list', ...args })) as ListPage;
}

function fireRequests(tabId: number, from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    fireDebuggerEvent(tabId, 'Network.requestWillBeSent', {
      requestId: `r${i}`,
      request: { url: `https://a.example/api/${i}`, method: 'GET' },
      timestamp: i,
    });
  }
}

async function collectAll(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ limit, cursor });
    seen.push(...page.requests.map((r) => r.requestId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return seen;
}

beforeEach(async () => {
  resetChromeState();
  resetNetworkState();
  addTab({ id: 10, url: 'https://a.example' });
  await exec({ cmd: 'start' });
});

describe('ring buffer（协议 §4.5）', () => {
  it('2000 条上限后丢最旧并累计 droppedCount', async () => {
    fireRequests(10, 1, 2001);
    const first = await list({ limit: 500 });
    expect(first.droppedCount).toBe(1);
    expect(first.requests[0]!.requestId).toBe('r2'); // 最旧的 r1 被丢

    const seen = await collectAll(500);
    expect(seen).toHaveLength(2000);
    expect(new Set(seen).size).toBe(2000); // 无重复
    expect(seen[0]).toBe('r2');
    expect(seen[1999]).toBe('r2001'); // 无遗漏
  });

  it('新 start 清空表与 droppedCount', async () => {
    fireRequests(10, 1, 2001);
    await exec({ cmd: 'start' });
    const page = await list();
    expect(page.requests).toHaveLength(0);
    expect(page.droppedCount).toBe(0);
  });
});

describe('list 分页（协议 §4.5）', () => {
  beforeEach(() => fireRequests(10, 1, 7));

  it('limit/cursor 翻页无重复无遗漏', async () => {
    const p1 = await list({ limit: 3 });
    expect(p1.requests.map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(p1.nextCursor).toBe('3');
    const p2 = await list({ limit: 3, cursor: p1.nextCursor });
    expect(p2.requests.map((r) => r.requestId)).toEqual(['r4', 'r5', 'r6']);
    expect(p2.nextCursor).toBe('6');
    const p3 = await list({ limit: 3, cursor: p2.nextCursor });
    expect(p3.requests.map((r) => r.requestId)).toEqual(['r7']);
    expect(p3.nextCursor).toBeUndefined();
    expect(p3.droppedCount).toBe(0);

    expect(await collectAll(3)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('limit 默认 50、范围 1–500，越界报错', async () => {
    expect((await list()).requests).toHaveLength(7);
    for (const bad of [0, 501, 1.5, '3'] as unknown[]) {
      await expect(exec({ cmd: 'list', limit: bad })).rejects.toThrow(/limit must be/);
    }
  });

  it('非法 cursor 报错；超出范围给空页', async () => {
    await expect(exec({ cmd: 'list', cursor: 'x' })).rejects.toThrow(/invalid cursor/);
    const page = await list({ cursor: '99' });
    expect(page.requests).toHaveLength(0);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filter 在分页之前应用', async () => {
    fireDebuggerEvent(10, 'Network.requestWillBeSent', {
      requestId: 'img1',
      request: { url: 'https://a.example/logo.png', method: 'GET' },
    });
    const page = await list({ filter: 'logo' });
    expect(page.requests.map((r) => r.requestId)).toEqual(['img1']);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('detail body_mode（协议 §4.5）', () => {
  beforeEach(() => {
    fireRequests(10, 1, 1);
    fireDebuggerEvent(10, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, mimeType: 'application/json' },
    });
  });

  function stubBody(text: string, base64Encoded = false): void {
    const original = chrome.debugger.sendCommand;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
      (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
        if (method === 'Network.getResponseBody') return { body: text, base64Encoded };
        return original(debuggee, method, params as object);
      }) as typeof chrome.debugger.sendCommand;
  }

  it('preview 默认截到 12000 字符并带 sourceChars/truncated', async () => {
    stubBody('x'.repeat(20_000));
    const res = (await exec({ cmd: 'detail', requestId: 'r1' })) as {
      body: string;
      sourceChars: number;
      truncated: boolean;
    };
    expect(res.body).toHaveLength(12_000);
    expect(res.sourceChars).toBe(20_000);
    expect(res.truncated).toBe(true);
  });

  it('preview 未超限时小 JSON 仍解析为对象', async () => {
    stubBody(JSON.stringify({ ok: true }));
    const res = (await exec({ cmd: 'detail', requestId: 'r1' })) as {
      body: unknown;
      truncated?: boolean;
    };
    expect(res.body).toEqual({ ok: true });
    expect(res.truncated).toBeUndefined();
  });

  it('file 模式走 artifact：preview 不伪装成合法 JSON', async () => {
    const body = '{"data":"' + 'y'.repeat(30_000) + '"}';
    stubBody(body);
    const res = (await exec({ cmd: 'detail', requestId: 'r1', body_mode: 'file' })) as {
      artifact: { encoding: string; mimeType: string; suggestedName: string; data: string };
      preview: string;
      sourceChars: number;
      truncated: boolean;
      body?: unknown;
    };
    expect(res.artifact.encoding).toBe('utf8');
    expect(res.artifact.mimeType).toBe('application/json');
    expect(res.artifact.data).toBe(body); // 完整内容不裁剪
    expect(res.sourceChars).toBe(body.length);
    expect(res.truncated).toBe(true);
    expect(res.body).toBeUndefined();
    expect(res.preview).toContain('preview truncated');
    expect(() => JSON.parse(res.preview)).toThrow(); // 明示预览文本，不是合法 JSON
  });

  it('full 显式内联；超 80000 报错并提示改 file', async () => {
    stubBody('z'.repeat(90_000));
    await expect(exec({ cmd: 'detail', requestId: 'r1', body_mode: 'full' })).rejects.toThrow(
      /body_mode=file/,
    );
  });

  it('body_mode 非法值报错', async () => {
    stubBody('{}');
    await expect(exec({ cmd: 'detail', requestId: 'r1', body_mode: 'raw' })).rejects.toThrow(
      /body_mode must be/,
    );
  });
});
