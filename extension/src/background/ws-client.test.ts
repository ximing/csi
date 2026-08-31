import { beforeEach, describe, expect, it } from 'vitest';
import { utf8ByteLengthExceeds, WsClient } from './ws-client';

type Listener = (event?: unknown) => void;

interface FakeEvent {
  data?: string;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  closed = false;

  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: string, event?: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(envelope: unknown): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }

  sentToolResults(): unknown[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((m) => m.type === 'tool_result');
  }
}

function installChrome(): void {
  const storage = new Map<string, unknown>();
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map((key) => [key, storage.get(key)]));
          },
          set: async (values: Record<string, unknown>) => {
            Object.entries(values).forEach(([key, value]) => storage.set(key, value));
          },
        },
        onChanged: { addListener: () => undefined },
      },
      runtime: { getManifest: () => ({ version: '0.6.0' }) },
    },
    WebSocket: FakeWebSocket,
  });
}

describe('WsClient connection state', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    installChrome();
  });

  it('reports and publishes connecting before the primary socket opens', async () => {
    const changes: string[] = [];
    const client = new WsClient({
      onToolCall: async () => undefined,
      tools: [],
      onConnectionStateChange: (state) => changes.push(state),
    });

    await client.connect('ws://127.0.0.1:10088/ws');

    expect(client.getConnectionState()).toBe('connecting');
    expect(changes).toEqual(['connecting']);

    FakeWebSocket.instances[0]!.emit('open');

    expect(client.getConnectionState()).toBe('connected');
    expect(changes).toEqual(['connecting', 'connected']);
  });

  it('replaces an in-flight connection when the configured URL changes', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });

    await client.connect('ws://127.0.0.1:10088/ws');
    await client.connect('ws://127.0.0.1:10089/ws');

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:10088/ws');
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:10089/ws');
    expect(client.getServerUrl()).toBe('ws://127.0.0.1:10089/ws');
    expect(client.getConnectionState()).toBe('connecting');
  });

  it('ignores tool calls arriving on a replaced socket', async () => {
    const calls: string[] = [];
    const client = new WsClient({
      onToolCall: async (name) => {
        calls.push(name);
        return { ok: true };
      },
      tools: [],
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const old = FakeWebSocket.instances[0]!;
    old.emit('open');

    await client.connect('ws://127.0.0.1:10089/ws'); // 换 URL，旧 socket 被 teardown
    const next = FakeWebSocket.instances[1]!;

    old.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'click', args: {} } });

    expect(calls).toEqual([]);
    expect(next.sentToolResults()).toEqual([]);
  });

  it('does not deliver a tool result on the socket that replaced the original one', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    const client = new WsClient({
      onToolCall: async (name) => {
        if (name === 'slow') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { ok: true };
      },
      tools: [],
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const old = FakeWebSocket.instances[0]!;
    old.emit('open');

    // 工具开始执行于旧连接，执行期间连接被替换
    old.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'slow', args: {} } });
    await client.connect('ws://127.0.0.1:10089/ws');
    const next = FakeWebSocket.instances[1]!;
    next.emit('open');

    releaseFirst?.({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 结果既不回旧连接（已关闭），也不串到新连接
    expect(old.sentToolResults()).toEqual([]);
    expect(next.sentToolResults()).toEqual([]);
  });

  it('replies with tool_result on the socket that received the call', async () => {
    const client = new WsClient({
      onToolCall: async () => ({ ok: true }),
      tools: [],
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    socket.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'click', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = socket.sentToolResults();
    expect(results).toHaveLength(1);
    expect((results[0] as { responseToRequestId?: string }).responseToRequestId).toBe('r1');
  });

  it('replies result_too_large instead of sending an oversized tool_result (protocol §3.2/§2.1)', async () => {
    const client = new WsClient({
      onToolCall: async () => ({ blob: 'x'.repeat(4096) }),
      tools: [],
      maxMessageBytes: 1024,
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    socket.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'evaluate', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = socket.sentToolResults() as {
      responseToRequestId: string;
      payload: { error?: string; code?: string };
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.responseToRequestId).toBe('r1');
    expect(results[0]!.payload.code).toBe('result_too_large');
    expect(results[0]!.payload.error).toMatch(/^result too large to deliver: ws transport limit exceeded/);
    // 发出的每一帧都不超上限
    for (const raw of socket.sent) {
      expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024);
    }
  });

  it('counts multi-byte characters by UTF-8 bytes, not UTF-16 code units', async () => {
    // 150 个 CJK 字符 = 150 码元 ≤ 300，但 UTF-8 450 字节 > 300：必须走精确测量拦截
    const client = new WsClient({
      onToolCall: async () => ({ text: '中'.repeat(150) }),
      tools: [],
      maxMessageBytes: 300,
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    socket.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'evaluate', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = socket.sentToolResults() as { payload: { code?: string } }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.payload.code).toBe('result_too_large');
  });

  it('sends tool_result unchanged when under the byte limit', async () => {
    const client = new WsClient({
      onToolCall: async () => ({ blob: 'x'.repeat(512) }),
      tools: [],
      maxMessageBytes: 4096,
    });

    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    socket.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'evaluate', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = socket.sentToolResults() as { payload: { data?: { blob: string } } }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.payload.data?.blob).toHaveLength(512);
  });
});

describe('utf8ByteLengthExceeds', () => {
  it('accepts when 3x code units fit within the limit', () => {
    expect(utf8ByteLengthExceeds('abc', 9)).toBe(false);
  });

  it('rejects when code units alone exceed the limit', () => {
    expect(utf8ByteLengthExceeds('a'.repeat(11), 10)).toBe(true);
  });

  it('measures exactly in the middle band (multi-byte chars)', () => {
    // 4 个 CJK 字符：4 码元、12 字节。limit=10 → 超；limit=12 → 不超
    expect(utf8ByteLengthExceeds('中'.repeat(4), 10)).toBe(true);
    expect(utf8ByteLengthExceeds('中'.repeat(4), 12)).toBe(false);
  });
});
