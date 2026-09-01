/**
 * index.ts（service worker 入口）测试：import 即副作用，所以 mock 掉 registry
 * 与 ws-client 两个直接依赖后再加载，验证接线本身——
 * 注册全部工具、onToolCall 转发 dispatchTool、连接状态变化广播给 popup、
 * reconcile alarm 路由，以及 popup 运行时消息（GET_STATUS/CONNECT/DISCONNECT/
 * TEST_CONNECTION/未知类型/异常路径）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from './test-chrome';

installChrome();

// index.ts 顶层就会 new WsClient + start，这里在加载前把 alarms/runtime 面
// 补进共享 chrome fake（test-chrome 没有这两个命名空间的可触发实现）。
const alarmListeners: Array<(alarm: { name: string }) => void> = [];
type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;
const runtimeMessageListeners: RuntimeMessageListener[] = [];
const sentRuntimeMessages: unknown[] = [];
let sendMessageImpl: (message: unknown) => Promise<unknown> = async (message) => {
  sentRuntimeMessages.push(message);
};

Object.assign(globalThis, {
  chrome: {
    ...chrome,
    alarms: { onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => alarmListeners.push(fn) } },
    runtime: {
      getManifest: () => ({ version: '0.7.0' }),
      sendMessage: (message: unknown) => sendMessageImpl(message),
      onMessage: { addListener: (fn: RuntimeMessageListener) => runtimeMessageListeners.push(fn) },
    },
  },
});

vi.mock('./registry', () => ({
  dispatchTool: vi.fn(async () => ({ ok: true })),
  registerAllTools: vi.fn(),
  toolNames: () => ['click', 'list_tabs'],
}));

vi.mock('./ws-client', () => {
  /** 与真实 WsClient 同名同方法的替身，静态表记录实例与调用。 */
  class WsClient {
    static instances: WsClient[] = [];
    static connectError: Error | null = null;
    startCalls = 0;
    reconcileCalls = 0;
    connectUrl?: string;
    testUrl?: string;
    disconnected = false;
    constructor(readonly options: unknown) {
      WsClient.instances.push(this);
    }
    async start(): Promise<void> {
      this.startCalls++;
    }
    isConnected(): boolean {
      return true;
    }
    getConnectionState(): string {
      return 'connected';
    }
    getServerUrl(): string {
      return 'ws://stored.example/ws';
    }
    getDaemonVersion(): string {
      return '0.8.1';
    }
    isReconcileAlarm(name: string): boolean {
      return name === 'csi-reconcile';
    }
    async connect(url: string): Promise<void> {
      if (WsClient.connectError) throw WsClient.connectError;
      this.connectUrl = url;
    }
    async disconnect(): Promise<void> {
      this.disconnected = true;
    }
    testConnection(url: string): Promise<{ ok: boolean }> {
      this.testUrl = url;
      return Promise.resolve({ ok: true });
    }
    async reconcile(): Promise<void> {
      this.reconcileCalls++;
    }
  }
  return { WsClient };
});

await import('./index');

const registry = await import('./registry');
const { dispatchTool, registerAllTools } = registry;
const { WsClient } = await import('./ws-client');

interface ClientStub {
  startCalls: number;
  reconcileCalls: number;
  connectUrl?: string;
  testUrl?: string;
  disconnected: boolean;
  options: {
    onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    tools: string[];
    onConnectionStateChange?: (state: string, serverUrl: string) => void;
  };
}

// 被 mock 的 WsClient 是同形替身，类型上仍按真实模块声明，这里绕过
const client = (WsClient as unknown as { instances: ClientStub[] }).instances[0]!;

/** 以 popup 的身份发一条运行时消息并等 sendResponse 被调用。 */
async function sendRuntimeMessage(message: unknown): Promise<unknown> {
  expect(runtimeMessageListeners).toHaveLength(1);
  let response: unknown;
  let responded = false;
  const done = new Promise<unknown>((resolve) => {
    const sendResponse = (r: unknown) => {
      responded = true;
      resolve(r);
    };
    const keepOpen = runtimeMessageListeners[0]!(message, {}, sendResponse);
    expect(keepOpen).toBe(true); // 异步 sendResponse 约定
    void keepOpen;
  });
  const r = await done;
  expect(responded).toBe(true);
  return r;
}

function clientOptions(): ClientStub['options'] {
  return client.options;
}

beforeEach(() => {
  // 不能 clearAllMocks：registerAllTools 的调用发生在 import 期，要留着数
  vi.mocked(dispatchTool).mockClear();
  // startCalls 不重置：start() 只在 import 期发生一次
  client.reconcileCalls = 0;
  client.connectUrl = undefined;
  client.testUrl = undefined;
  client.disconnected = false;
  (WsClient as unknown as { connectError: Error | null }).connectError = null;
  sentRuntimeMessages.length = 0;
  sendMessageImpl = async (message) => {
    sentRuntimeMessages.push(message);
  };
});

describe('入口接线', () => {
  it('注册全部工具，用工具清单构造唯一的 WsClient，并启动它', () => {
    expect(registerAllTools).toHaveBeenCalledTimes(1);
    expect((WsClient as unknown as { instances: ClientStub[] }).instances).toHaveLength(1);
    expect(clientOptions().tools).toEqual(['click', 'list_tabs']);
    expect(client.startCalls).toBe(1);
  });

  it('onToolCall 转发给 dispatchTool', async () => {
    await clientOptions().onToolCall('click', { selector: '@e1' });
    expect(dispatchTool).toHaveBeenCalledWith('click', { selector: '@e1' });
  });

  it('连接状态变化广播 CONNECTION_STATE_CHANGED 给 popup', () => {
    clientOptions().onConnectionStateChange!('connected', 'ws://127.0.0.1:10088/ws');
    expect(sentRuntimeMessages).toEqual([
      { type: 'CONNECTION_STATE_CHANGED', state: 'connected', serverUrl: 'ws://127.0.0.1:10088/ws' },
    ]);
  });

  it('popup 不在时广播被静默忽略（sendMessage 拒绝也不抛）', async () => {
    sendMessageImpl = () => Promise.reject(new Error('Could not establish connection'));
    clientOptions().onConnectionStateChange!('disconnected', 'ws://x/ws');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentRuntimeMessages).toEqual([]);
  });

  it('csi-reconcile alarm 触发 reconcile，其他 alarm 忽略', () => {
    expect(alarmListeners).toHaveLength(1);
    alarmListeners[0]!({ name: 'csi-reconcile' });
    expect(client.reconcileCalls).toBe(1);
    alarmListeners[0]!({ name: 'someone-elses-alarm' });
    expect(client.reconcileCalls).toBe(1);
  });
});

describe('popup 运行时消息', () => {
  it('GET_STATUS 返回连接状态（等 startup 完成后再答）', async () => {
    await expect(sendRuntimeMessage({ type: 'GET_STATUS' })).resolves.toEqual({
      connected: true,
      state: 'connected',
      serverUrl: 'ws://stored.example/ws',
      daemonVersion: '0.8.1', // 透传 wsClient.getDaemonVersion()
    });
  });

  it('CONNECT 连接指定 URL 并回 success', async () => {
    await expect(sendRuntimeMessage({ type: 'CONNECT', url: 'ws://127.0.0.1:10088/ws' })).resolves.toEqual({
      success: true,
    });
    expect(client.connectUrl).toBe('ws://127.0.0.1:10088/ws');
  });

  it('CONNECT 失败时把错误带回给 popup', async () => {
    (WsClient as unknown as { connectError: Error | null }).connectError = new Error('boom');
    await expect(sendRuntimeMessage({ type: 'CONNECT', url: 'ws://bad/ws' })).resolves.toEqual({
      error: 'boom',
    });
  });

  it('DISCONNECT 断开并回 success', async () => {
    await expect(sendRuntimeMessage({ type: 'DISCONNECT' })).resolves.toEqual({ success: true });
    expect(client.disconnected).toBe(true);
  });

  it('TEST_CONNECTION 返回探测结果', async () => {
    await expect(sendRuntimeMessage({ type: 'TEST_CONNECTION', url: 'ws://probe/ws' })).resolves.toEqual({
      ok: true,
    });
    expect(client.testUrl).toBe('ws://probe/ws');
  });

  it('未知类型返回错误说明', async () => {
    await expect(sendRuntimeMessage({ type: 'WHATEVER' })).resolves.toEqual({
      error: 'unknown type: WHATEVER',
    });
  });

  it('消息缺 type 同样走未知类型分支', async () => {
    await expect(sendRuntimeMessage({})).resolves.toEqual({ error: 'unknown type: undefined' });
  });
});
