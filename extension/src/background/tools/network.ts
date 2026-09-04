/**
 * network (protocol §4 / §4.5): start/stop capture, list collected requests,
 * fetch a response body. Capture state is per-tab; a single global
 * debugger.onEvent listener fans events into the per-tab tables.
 *
 * 每 tab 捕获表是最多 2000 条的 ring buffer：溢出丢最旧记录并累计
 * droppedCount（协议 §4.5）。list 分页返回，detail 按 body_mode 做预算。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { DEFAULT_PREVIEW_CHARS, INLINE_MAX_CHARS, makeArtifact } from './artifact';

interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  completed?: boolean;
  timestamp?: number;
}

/** 每 tab 捕获表上限（协议 §4.5）。 */
const CAPTURE_MAX = 2_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

const capturingTabIds = new Set<number>();
const requestsByTab = new Map<number, Map<string, CapturedRequest>>();
const droppedByTab = new Map<number, number>();
let eventListenerRegistered = false;

function requestsFor(tabId: number): Map<string, CapturedRequest> {
  let table = requestsByTab.get(tabId);
  if (!table) {
    table = new Map();
    requestsByTab.set(tabId, table);
  }
  return table;
}

/** 测试用：清掉全部捕获状态。 */
export function resetNetworkState(): void {
  capturingTabIds.clear();
  requestsByTab.clear();
  droppedByTab.clear();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturingTabIds.delete(tabId);
  requestsByTab.delete(tabId);
  droppedByTab.delete(tabId);
});

/** 写入一条新请求；表满时丢最旧并累计 droppedCount（协议 §4.5）。 */
function recordRequest(tabId: number, entry: CapturedRequest): void {
  const table = requestsFor(tabId);
  if (table.has(entry.requestId)) {
    table.set(entry.requestId, entry); // 同 requestId 重发（重定向等）：原位更新
    return;
  }
  if (table.size >= CAPTURE_MAX) {
    const oldest = table.keys().next().value!;
    table.delete(oldest);
    droppedByTab.set(tabId, (droppedByTab.get(tabId) ?? 0) + 1);
  }
  table.set(entry.requestId, entry);
}

function registerEventListener(): void {
  if (eventListenerRegistered) return;
  eventListenerRegistered = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId || !capturingTabIds.has(tabId) || !params) return;
    const table = requestsFor(tabId);
    const p = params as {
      requestId: string;
      timestamp?: number;
      request?: { url: string; method: string };
      response?: { status: number; mimeType: string };
    };
    if (method === 'Network.requestWillBeSent') {
      recordRequest(tabId, {
        requestId: p.requestId,
        url: p.request!.url,
        method: p.request!.method,
        timestamp: p.timestamp,
      });
    }
    if (method === 'Network.responseReceived') {
      const entry = table.get(p.requestId);
      if (entry) {
        entry.status = p.response!.status;
        entry.mimeType = p.response!.mimeType;
      }
    }
    if (method === 'Network.loadingFinished') {
      const entry = table.get(p.requestId);
      if (entry) entry.completed = true;
    }
  });
}

export class NetworkTool implements Tool {
  readonly name = 'network';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const cmd = args.cmd as string | undefined;
    if (!cmd) throw new Error('network: cmd is required (start/stop/list/detail)');
    switch (cmd) {
      case 'start':
        return this.start(target.tabId);
      case 'stop':
        return this.stop(target.tabId);
      case 'list':
        return this.list(
          target.tabId,
          args.filter as string | undefined,
          args.limit,
          args.cursor,
        );
      case 'detail':
        return this.detail(
          target.tabId,
          args.requestId as string | undefined,
          args.body_mode,
        );
      default:
        throw new Error(`network: unknown cmd "${cmd}"`);
    }
  }

  private async start(tabId: number): Promise<unknown> {
    requestsByTab.set(tabId, new Map());
    droppedByTab.set(tabId, 0);
    capturingTabIds.add(tabId);
    registerEventListener();
    await sendCommand(tabId, 'Network.enable');
    return { success: true, message: 'network capture started' };
  }

  private async stop(tabId: number): Promise<unknown> {
    capturingTabIds.delete(tabId);
    try {
      await sendCommand(tabId, 'Network.disable');
    } catch {
      // already detached / domain disabled — fine
    }
    return { success: true, message: 'network capture stopped' };
  }

  private list(tabId: number, filter: string | undefined, rawLimit: unknown, rawCursor: unknown): unknown {
    const limit = parseLimit(rawLimit);
    const cursor = parseCursor(rawCursor);
    let requests = [...requestsFor(tabId).values()];
    if (filter) requests = requests.filter((r) => r.url.includes(filter));
    // cursor 是过滤后序列表里的下标（字符串），驱动方一页页翻即可（协议 §4.5）。
    const page = requests.slice(cursor, cursor + limit);
    const next = cursor + limit < requests.length ? String(cursor + limit) : undefined;
    return {
      requests: page.map((r) => ({
        requestId: r.requestId,
        url: r.url,
        method: r.method,
        status: r.status,
        mimeType: r.mimeType,
        completed: r.completed ?? false,
      })),
      ...(next !== undefined ? { nextCursor: next } : {}),
      droppedCount: droppedByTab.get(tabId) ?? 0,
    };
  }

  private async detail(tabId: number, requestId: string | undefined, rawBodyMode: unknown): Promise<unknown> {
    if (!requestId) throw new Error('network: requestId is required for detail');
    const bodyMode = parseBodyMode(rawBodyMode);
    const entry = requestsFor(tabId).get(requestId);
    if (!entry) throw new Error(`network: request "${requestId}" not found`);
    const body = await sendCommand<{ body: string; base64Encoded: boolean }>(
      tabId,
      'Network.getResponseBody',
      { requestId },
    );
    const meta = {
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      status: entry.status,
      mimeType: entry.mimeType,
      base64Encoded: body.base64Encoded,
    };
    const text = body.body;
    const sourceChars = text.length;

    if (bodyMode === 'preview') {
      // preview：body 取前 12000 字符（协议 §4.5 未给可调参数，固定值）。
      if (sourceChars <= DEFAULT_PREVIEW_CHARS) {
        return { ...meta, body: maybeParseJson(text, body.base64Encoded) };
      }
      return {
        ...meta,
        body: text.slice(0, DEFAULT_PREVIEW_CHARS),
        sourceChars,
        truncated: true,
      };
    }

    if (bodyMode === 'full') {
      // full 仅显式请求；超 80000 是调用方的用法问题，提示改 file（协议 §4.5）。
      if (sourceChars > INLINE_MAX_CHARS) {
        throw new Error(
          `network: body is ${sourceChars} chars, over the 80000 inline limit for body_mode=full; use body_mode=file`,
        );
      }
      return { ...meta, body: maybeParseJson(text, body.base64Encoded) };
    }

    // file：body 经 artifact 落盘，只内联 preview + 元信息（协议 §3.5/§4.5/§5）。
    const env = makeArtifact({
      data: text,
      mimeType: entry.mimeType ?? 'application/octet-stream',
      suggestedName: suggestBodyName(requestId, entry.mimeType),
    });
    return {
      ...meta,
      truncated: true,
      preview: env.preview,
      sourceChars: env.sourceChars,
      artifact: env.artifact,
    };
  }
}

function maybeParseJson(text: string, base64Encoded: boolean): unknown {
  if (base64Encoded) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function suggestBodyName(requestId: string, mimeType?: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, '_');
  const ext =
    mimeType === 'application/json' ? 'json'
    : mimeType && mimeType.startsWith('text/html') ? 'html'
    : mimeType && mimeType.startsWith('text/') ? 'txt'
    : 'bin';
  return `csi-network-body-${safe}.${ext}`;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIST_LIMIT;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_LIST_LIMIT) {
    throw new Error('network: limit must be an integer between 1 and 500');
  }
  return raw;
}

function parseCursor(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw !== 'string') throw new Error('network: cursor must be a string');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`network: invalid cursor "${raw}"`);
  return n;
}

function parseBodyMode(raw: unknown): 'preview' | 'file' | 'full' {
  if (raw === undefined || raw === null) return 'preview';
  if (raw === 'preview' || raw === 'file' || raw === 'full') return raw;
  throw new Error('network: body_mode must be preview, file, or full');
}
