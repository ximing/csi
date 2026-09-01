/**
 * ws-client 自动重连与生命周期测试（协议 §3.1/§3.2）：
 * start() 的 reconcile alarm 周期设置与 storage.onChanged 响应、reconcile 的
 * 期望态收敛、connect 超时、disconnect、testConnection 探测五路，
 * 以及消息处理（ping/hello_ack/未知类型/坏 JSON/缺工具名/带 code 的错误）。
 * 与 ws-client.test.ts 同一套 FakeWebSocket 手法，此处补 alarm/storage 面。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from './ws-client';

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
    if (url === '%%invalid') throw new Error('bad url');
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

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(envelope: unknown): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }
}

const storage = new Map<string, unknown>();
const storageListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
const alarmOps: { op: 'clear' | 'create'; name: string; info?: unknown }[] = [];

function installChrome(): void {
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
        onChanged: { addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => storageListeners.push(fn) },
      },
      alarms: {
        clear: async (name: string) => {
          alarmOps.push({ op: 'clear', name });
          return true;
        },
        create: async (name: string, info: unknown) => {
          alarmOps.push({ op: 'create', name, info });
        },
      },
      runtime: { getManifest: () => ({ version: '0.7.0' }) },
    },
    WebSocket: FakeWebSocket,
  });
}

const DEFAULT_URL = 'ws://127.0.0.1:10088/ws';

beforeEach(() => {
  FakeWebSocket.instances = [];
  storage.clear();
  storageListeners.length = 0;
  alarmOps.length = 0;
  installChrome();
});

describe('start 与 reconcile alarm（协议 §3.1）', () => {
  it('默认 30s 周期：先清旧 alarm 再建 0.5 分钟周期的 alarm，并按期望态连默认地址', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.start();
    expect(alarmOps).toEqual([
      { op: 'clear', name: 'csi-reconcile' },
      { op: 'create', name: 'csi-reconcile', info: { periodInMinutes: 0.5 } },
    ]);
    // storage 为空 → 默认"要连"，连 DEFAULT_WS_URL
    expect(FakeWebSocket.instances.map((s) => s.url)).toEqual([DEFAULT_URL]);
    await client.disconnect();
  });

  it('storage 里的自定义周期生效，且低于 30s 被钳到 30s（chrome.alarms 下限）', async () => {
    storage.set('reconcile_period_seconds', 90);
    const a = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await a.start();
    storage.set('ws_should_connect', false); // 第二个 client 保持断开
    storage.set('reconcile_period_seconds', 5);
    const b = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await b.start();
    const creates = alarmOps.filter((o) => o.op === 'create');
    expect(creates[0]!.info).toEqual({ periodInMinutes: 1.5 });
    expect(creates[1]!.info).toEqual({ periodInMinutes: 0.5 }); // 5s → 30s
  });

  it('周期为 0 表示关闭自动重连：只清不建', async () => {
    storage.set('reconcile_period_seconds', 0);
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.start();
    expect(alarmOps).toEqual([{ op: 'clear', name: 'csi-reconcile' }]);
    // 期望态默认仍是连——start 里的 reconcile 不受周期开关影响
    expect(FakeWebSocket.instances).toHaveLength(1);
    await client.disconnect();
  });

  it('storage.onChanged 收到本地 reconcile_period_seconds 变化时重建 alarm', async () => {
    storage.set('ws_should_connect', false); // 期望断开，start 不开连接，专注 alarm
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.start();
    expect(storageListeners).toHaveLength(1);
    alarmOps.length = 0;
    storage.set('reconcile_period_seconds', 120);
    for (const fn of [...storageListeners]) fn({ reconcile_period_seconds: { newValue: 120 } }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alarmOps).toEqual([
      { op: 'clear', name: 'csi-reconcile' },
      { op: 'create', name: 'csi-reconcile', info: { periodInMinutes: 2 } },
    ]);
  });

  it('非 local 区或其他 key 的 storage 变化不触发重建', async () => {
    storage.set('ws_should_connect', false);
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.start();
    alarmOps.length = 0;
    for (const fn of [...storageListeners]) fn({ reconcile_period_seconds: {} }, 'sync');
    for (const fn of [...storageListeners]) fn({ other_key: {} }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alarmOps).toEqual([]);
  });

  it('isReconcileAlarm 只认 csi-reconcile', () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    expect(client.isReconcileAlarm('csi-reconcile')).toBe(true);
    expect(client.isReconcileAlarm('other')).toBe(false);
  });
});

describe('reconcile 期望态收敛', () => {
  it('期望断开时拆掉已建立的连接', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    expect(client.isConnected()).toBe(true);

    await client.disconnect();
    expect(client.getConnectionState()).toBe('disconnected');
    expect(socket.closed).toBe(true);
    expect(storage.get('ws_should_connect')).toBe(false);

    // 再次 reconcile：期望仍是断开，不开新连接
    await client.reconcile();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('已连接且 URL 未变时 reconcile 不重连', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    FakeWebSocket.instances[0]!.emit('open');
    await client.reconcile();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getConnectionState()).toBe('connected');
  });

  it('connecting 期间 reconcile 不开第二个连接', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws'); // 停在 connecting
    await client.reconcile();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('已连接但期望 URL 变了：拆旧连新', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    const old = FakeWebSocket.instances[0]!;
    old.emit('open');

    await client.connect('ws://127.0.0.1:10089/ws');
    expect(old.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getServerUrl()).toBe('ws://127.0.0.1:10089/ws');
  });

  it('storage 里记住的 URL 优先于默认地址', async () => {
    storage.set('local_url', 'ws://127.0.0.1:7777/ws');
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.reconcile();
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:7777/ws');
  });
});

describe('连接超时', () => {
  it('half-open 连接在 CONNECT_TIMEOUT 后被关闭', async () => {
    vi.useFakeTimers();
    try {
      const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
      await client.connect('ws://127.0.0.1:10088/ws');
      const socket = FakeWebSocket.instances[0]!;
      expect(client.getConnectionState()).toBe('connecting');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.closed).toBe(true);
      expect(client.getConnectionState()).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('testConnection 探测', () => {
  it('已连接且同 host 时直接 ok，不新开探测连接', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    FakeWebSocket.instances[0]!.emit('open');

    const result = await client.testConnection('ws://127.0.0.1:10088/health');
    expect(result).toEqual({ ok: true });
    expect(FakeWebSocket.instances).toHaveLength(1); // 没有新探测
  });

  it('未连接时即使同地址也要探测；open 即 ok 并关掉探测连接', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    const result = client.testConnection('ws://127.0.0.1:10088/ws');
    const probe = FakeWebSocket.instances[0]!;
    probe.emit('open');
    await expect(result).resolves.toEqual({ ok: true });
    expect(probe.closed).toBe(true);
  });

  it('连接失败（error 事件）返回 connect failed', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    const result = client.testConnection('ws://127.0.0.1:9999/ws');
    FakeWebSocket.instances[0]!.emit('error');
    await expect(result).resolves.toEqual({ ok: false, reason: 'connect failed' });
  });

  it('5s 无响应按超时处理', async () => {
    vi.useFakeTimers();
    try {
      const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
      const result = client.testConnection('ws://10.255.255.1:1/ws');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('非法 URL 直接返回失败原因', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await expect(client.testConnection('%%invalid')).resolves.toEqual({
      ok: false,
      reason: 'bad url',
    });
  });

  it('已连接但探测的是别的 host：走真探测', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    FakeWebSocket.instances[0]!.emit('open');

    const result = client.testConnection('ws://localhost:9999/ws');
    const probe = FakeWebSocket.instances[1]!;
    probe.emit('open');
    await expect(result).resolves.toEqual({ ok: true });
    // 主连接不受探测影响
    expect(client.isConnected()).toBe(true);
  });
});

describe('断线退避自动重连', () => {
  it('close 后按退避序列自动重连，不等 reconcile alarm', async () => {
    vi.useFakeTimers();
    try {
      const client = new WsClient({ onToolCall: async () => ({}), tools: [], retryDelaysMs: [10, 20, 40] });
      await client.connect(DEFAULT_URL);
      const first = FakeWebSocket.instances[0]!;
      first.emit('open');
      first.emitMessage({ type: 'hello_ack', payload: { daemonVersion: '0.7.0', tools: [] } });
      first.close(); // 模拟 daemon 重启断开
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10); // 第一次退避
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.close();
      await vi.advanceTimersByTimeAsync(20);
      expect(FakeWebSocket.instances).toHaveLength(3);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect() 后不自动重连', async () => {
    vi.useFakeTimers();
    try {
      const client = new WsClient({ onToolCall: async () => ({}), tools: [], retryDelaysMs: [10, 20, 40] });
      await client.connect(DEFAULT_URL);
      FakeWebSocket.instances[0]!.emit('open');
      await client.disconnect(); // teardown 触发的 close 不得调度重试
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hello_ack 后重置退避序列', async () => {
    vi.useFakeTimers();
    try {
      const client = new WsClient({ onToolCall: async () => ({}), tools: [], retryDelaysMs: [10, 20, 40] });
      await client.connect(DEFAULT_URL);
      FakeWebSocket.instances[0]!.emit('open');
      FakeWebSocket.instances[0]!.emitMessage({ type: 'hello_ack', payload: {} });
      FakeWebSocket.instances[0]!.close();
      await vi.advanceTimersByTimeAsync(10); // 用掉第一档
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.emit('open');
      FakeWebSocket.instances[1]!.emitMessage({ type: 'hello_ack', payload: {} }); // 重置
      FakeWebSocket.instances[1]!.close();
      await vi.advanceTimersByTimeAsync(10); // 又回到第一档而非第二档
      expect(FakeWebSocket.instances).toHaveLength(3);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('消息处理', () => {
  async function connectedClient(options: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
    const client = new WsClient({
      onToolCall: async () => undefined,
      tools: ['click'],
      ...options,
    });
    await client.connect('ws://127.0.0.1:10088/ws');
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    return { client, socket };
  }

  it('open 后发 hello（版本 + 工具清单）', async () => {
    const { socket } = await connectedClient();
    const hello = socket.sent.map((raw) => JSON.parse(raw) as { type: string }).find((m) => m.type === 'hello');
    expect(hello).toMatchObject({ payload: { extensionVersion: '0.7.0', tools: ['click'] } });
  });

  it('ping 回 pong', async () => {
    const { socket } = await connectedClient();
    socket.emitMessage({ type: 'ping' });
    expect(socket.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual(
      expect.objectContaining({ type: 'pong' }),
    );
  });

  it('hello_ack 静默；未知类型只记日志', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { socket } = await connectedClient();
      const before = socket.sent.length;
      socket.emitMessage({ type: 'hello_ack' });
      socket.emitMessage({ type: 'mystery' });
      expect(socket.sent.length).toBe(before); // 都不回包
      expect(log).toHaveBeenCalledWith('[ws] unhandled message type:', 'mystery');
    } finally {
      log.mockRestore();
    }
  });

  it('坏 JSON 消息只记错误不崩', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { socket, client } = await connectedClient();
      socket.emit('message', { data: '{not json' });
      expect(client.isConnected()).toBe(true);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('socket error 事件只记日志，不断状态', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { socket, client } = await connectedClient();
      socket.emit('error', new Error('x'));
      expect(client.isConnected()).toBe(true);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('缺工具名时回 missing tool name', async () => {
    const { socket } = await connectedClient();
    socket.emitMessage({ type: 'tool_call', requestId: 'r9', payload: { args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const results = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload?: { error?: string } })
      .filter((m) => m.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.payload?.error).toBe('missing tool name');
  });

  it('工具抛错时错误消息与 code/details 一并带回', async () => {
    const { socket } = await connectedClient({
      onToolCall: async () => {
        throw Object.assign(new Error('boom'), { code: 'stale_target', details: { tabId: 3 } });
      },
    });
    socket.emitMessage({ type: 'tool_call', requestId: 'r1', payload: { name: 'click', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const results = socket.sent
      .map((raw) => JSON.parse(raw) as {
        type: string;
        payload?: { error?: string; code?: string; details?: unknown };
      })
      .filter((m) => m.type === 'tool_result');
    expect(results[0]!.payload).toEqual({ error: 'boom', code: 'stale_target', details: { tabId: 3 } });
  });

  it('工具抛非 Error 值时用字符串化消息', async () => {
    const { socket } = await connectedClient({
      onToolCall: async () => {
        throw 'plain failure'; // eslint-disable-line no-throw-literal
      },
    });
    socket.emitMessage({ type: 'tool_call', requestId: 'r2', payload: { name: 'click', args: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const results = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload?: { error?: string } })
      .filter((m) => m.type === 'tool_result');
    expect(results[0]!.payload?.error).toBe('plain failure');
  });

  it('执行期间 socket 已非 OPEN 时丢弃结果', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { socket } = await connectedClient({
      onToolCall: async () => {
        await gate;
        return { ok: true };
      },
    });
    socket.emitMessage({ type: 'tool_call', requestId: 'r3', payload: { name: 'click', args: {} } });
    socket.readyState = FakeWebSocket.CLOSED; // 执行期间连接关了
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent.filter((raw) => raw.includes('tool_result'))).toEqual([]);
  });

  it('当前 socket 关闭后状态回 disconnected，之后的 send 不再发', async () => {
    const { socket, client } = await connectedClient();
    socket.close();
    expect(client.getConnectionState()).toBe('disconnected');
    socket.emitMessage({ type: 'ping' });
    expect(socket.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === 'pong')).toEqual([]);
    await client.disconnect(); // 清掉 close 触发的退避重试定时器，防污染后续用例
  });

  it('被替换的旧 socket 迟到 open：只关掉，不发 hello', async () => {
    const client = new WsClient({ onToolCall: async () => undefined, tools: [] });
    await client.connect('ws://127.0.0.1:10088/ws');
    const old = FakeWebSocket.instances[0]!;
    await client.connect('ws://127.0.0.1:10089/ws'); // 旧 socket 被 teardown

    old.emit('open'); // 迟到的 open
    expect(old.sent).toEqual([]); // 没有 hello
    expect(client.getConnectionState()).toBe('connecting'); // 新连接不受影响
    expect(FakeWebSocket.instances[1]!.closed).toBe(false);
  });
});

afterEach(() => {
  vi.clearAllTimers(); // 清掉用例残留的退避重试定时器（fake timers 场景）
  vi.restoreAllMocks();
});
