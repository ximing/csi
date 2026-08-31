/**
 * network (protocol §4.7): start/stop capture, list collected requests,
 * fetch a response body. Capture state is per-tab; a single global
 * debugger.onEvent listener fans events into the per-tab tables.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';

interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  completed?: boolean;
  timestamp?: number;
}

const capturingTabIds = new Set<number>();
const requestsByTab = new Map<number, Map<string, CapturedRequest>>();
let eventListenerRegistered = false;

function requestsFor(tabId: number): Map<string, CapturedRequest> {
  let table = requestsByTab.get(tabId);
  if (!table) {
    table = new Map();
    requestsByTab.set(tabId, table);
  }
  return table;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  capturingTabIds.delete(tabId);
  requestsByTab.delete(tabId);
});

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
      table.set(p.requestId, {
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
        return this.list(target.tabId, args.filter as string | undefined);
      case 'detail':
        return this.detail(target.tabId, args.requestId as string | undefined);
      default:
        throw new Error(`network: unknown cmd "${cmd}"`);
    }
  }

  private async start(tabId: number): Promise<unknown> {
    requestsByTab.set(tabId, new Map());
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

  private list(tabId: number, filter?: string): unknown {
    let requests = [...requestsFor(tabId).values()];
    if (filter) requests = requests.filter((r) => r.url.includes(filter));
    return {
      count: requests.length,
      requests: requests.map((r) => ({
        requestId: r.requestId,
        url: r.url,
        method: r.method,
        status: r.status,
        mimeType: r.mimeType,
        completed: r.completed ?? false,
      })),
    };
  }

  private async detail(tabId: number, requestId?: string): Promise<unknown> {
    if (!requestId) throw new Error('network: requestId is required for detail');
    const entry = requestsFor(tabId).get(requestId);
    if (!entry) throw new Error(`network: request "${requestId}" not found`);
    const body = await sendCommand<{ body: string; base64Encoded: boolean }>(
      tabId,
      'Network.getResponseBody',
      { requestId },
    );
    let parsed: unknown = body.body;
    if (!body.base64Encoded) {
      try {
        parsed = JSON.parse(body.body);
      } catch {
        // not JSON — return raw text
      }
    }
    return {
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      status: entry.status,
      mimeType: entry.mimeType,
      base64Encoded: body.base64Encoded,
      body: parsed,
    };
  }
}
