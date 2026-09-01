/**
 * WebSocket client to the daemon (protocol §3).
 *
 * Connection intent (`ws_should_connect`, `local_url`) is persisted in
 * chrome.storage.local so a suspended service worker can be reconciled by
 * the `csi-reconcile` alarm (every 0.5 min): if we should be
 * connected but aren't, reconnect.
 */
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_RECONCILE_PERIOD_SECONDS,
  DEFAULT_WS_URL,
  RECONCILE_ALARM,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  ConnectionState,
  HelloAckPayload,
  HelloPayload,
  ToolCallPayload,
  ToolResultPayload,
  WsEnvelope,
} from '../shared/messages';

interface DesiredState {
  shouldConnect: boolean;
  url: string;
}

/**
 * WS 单消息字节上限（协议 §3.2），与 daemon 读上限一致：160MiB。
 * 取值依据：协议 §5 的 PDF 落盘上限 100MB（解码后）经 base64 传输约 133MiB，
 * 再加 JSON 信封余量。
 */
export const WS_MAX_MESSAGE_BYTES = 160 * 1024 * 1024;

/**
 * 序列化后的 UTF-8 字节数是否超 limit。
 * JS string.length 是 UTF-16 码元数：字节数 ∈ [码元数, 3×码元数]，
 * 两端直接判定，只有中间地带才花一次 TextEncoder 精确测量。
 */
export function utf8ByteLengthExceeds(text: string, limit: number): boolean {
  if (text.length > limit) return true; // 字节数 ≥ 码元数，必超
  if (text.length * 3 <= limit) return false; // 字节数 ≤ 3×码元数，必不超
  return new TextEncoder().encode(text).length > limit;
}

export interface WsClientOptions {
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  tools: string[];
  onConnectionStateChange?: (state: ConnectionState, serverUrl: string) => void;
  /** WS 单消息字节上限，默认 WS_MAX_MESSAGE_BYTES（协议 §3.2）；测试可注入小值。 */
  maxMessageBytes?: number;
  /** 断线重连退避序列（毫秒），默认 [1000, 2000, 5000, 10000, 30000]，封顶取末位；测试可注入小值。 */
  retryDelaysMs?: number[];
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

export class WsClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private currentUrl = '';
  private connectingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onToolCall: WsClientOptions['onToolCall'];
  private readonly tools: string[];
  private readonly onConnectionStateChange?: WsClientOptions['onConnectionStateChange'];
  private readonly maxMessageBytes: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly retryDelaysMs: number[];
  /** 最近一次 hello_ack 上报的 daemon 版本；未握手过时为空串。 */
  private daemonVersion = '';

  constructor(options: WsClientOptions) {
    this.onToolCall = options.onToolCall;
    this.tools = options.tools;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.maxMessageBytes = options.maxMessageBytes ?? WS_MAX_MESSAGE_BYTES;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 5000, 10000, 30000];
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getServerUrl(): string {
    return this.currentUrl;
  }

  getDaemonVersion(): string {
    return this.daemonVersion;
  }

  isReconcileAlarm(alarmName: string): boolean {
    return alarmName === RECONCILE_ALARM;
  }

  async start(): Promise<void> {
    await this.applyReconcilePeriod();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEYS.RECONCILE_PERIOD]) {
        void this.applyReconcilePeriod();
      }
    });
    await this.reconcile();
  }

  /** 按 storage 里的周期重建 reconcile alarm；0 = 关闭自动重连。 */
  private async applyReconcilePeriod(): Promise<void> {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RECONCILE_PERIOD);
    const seconds =
      (stored[STORAGE_KEYS.RECONCILE_PERIOD] as number | undefined) ?? DEFAULT_RECONCILE_PERIOD_SECONDS;
    await chrome.alarms.clear(RECONCILE_ALARM);
    if (seconds > 0) {
      // chrome.alarms 周期下限 30s
      await chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: Math.max(seconds, 30) / 60 });
    }
  }

  async connect(url: string): Promise<void> {
    await this.setDesired({ shouldConnect: true, url });
    await this.reconcile();
  }

  async disconnect(): Promise<void> {
    await this.setDesired({ shouldConnect: false, url: this.currentUrl });
    this.resetRetry(); // 手动断开不留下挂起的重试
    this.teardown();
  }

  async reconcile(): Promise<void> {
    const desired = await this.getDesired();
    if (!desired.shouldConnect) {
      if (this.state !== 'disconnected') this.teardown();
      return;
    }
    const url = desired.url || DEFAULT_WS_URL;
    if (this.state !== 'disconnected' && this.currentUrl !== url) this.teardown();
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.openSocket(url);
  }

  /** Probe a URL without disturbing the primary connection. */
  testConnection(url: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.isConnected() && sameHost(url, this.currentUrl)) {
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve) => {
      let probe: WebSocket;
      try {
        probe = new WebSocket(url);
      } catch (err) {
        resolve({ ok: false, reason: (err as Error)?.message || 'invalid url' });
        return;
      }
      let settled = false;
      const finish = (result: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          probe.close();
        } catch {
          // ignore
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 5000);
      probe.addEventListener('open', () => finish({ ok: true }));
      probe.addEventListener('error', () => finish({ ok: false, reason: 'connect failed' }));
    });
  }

  private openSocket(url: string): void {
    this.currentUrl = url;
    this.setConnectionState('connecting');
    const socket = new WebSocket(url);
    this.socket = socket;

    this.connectingTimer = setTimeout(() => {
      if (this.socket === socket && this.state === 'connecting') socket.close();
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      this.setConnectionState('connected');
      this.clearConnectingTimer();
      console.log('[ws] connected to', url);
      const payload: HelloPayload = {
        extensionVersion: chrome.runtime.getManifest().version,
        tools: this.tools,
      };
      this.send({ type: 'hello', payload });
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return; // 迟到消息：连接已被替换/拆除，丢弃
      try {
        this.handleMessage(JSON.parse(String(event.data)) as WsEnvelope, socket);
      } catch (err) {
        console.error('[ws] invalid message:', err);
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnectionState('disconnected');
      this.clearConnectingTimer();
      console.log('[ws] disconnected');
      void this.scheduleRetry();
    });

    socket.addEventListener('error', (event) => {
      console.error('[ws] error:', event);
    });
  }

  private teardown(): void {
    this.resetRetry();
    this.clearConnectingTimer();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.setConnectionState('disconnected');
  }

  /** close 后按指数退避自动重连（协议无变更，纯客户端行为）；
   *  与 csi-reconcile alarm 共存：alarm 是 30s 兜底，这里是秒级快路径。 */
  private async scheduleRetry(): Promise<void> {
    const desired = await this.getDesired();
    if (!desired.shouldConnect || this.retryTimer) return;
    const delays = this.retryDelaysMs;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)]!;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, delay);
  }

  private resetRetry(): void {
    this.retryAttempt = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onConnectionStateChange?.(state, this.currentUrl);
  }

  private clearConnectingTimer(): void {
    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = null;
    }
  }

  private async getDesired(): Promise<DesiredState> {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.SHOULD_CONNECT, STORAGE_KEYS.URL]);
    return {
      // Default is "connect" so the extension works out of the box.
      shouldConnect: stored[STORAGE_KEYS.SHOULD_CONNECT] !== false,
      url: (stored[STORAGE_KEYS.URL] as string) || '',
    };
  }

  private async setDesired(desired: DesiredState): Promise<void> {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SHOULD_CONNECT]: desired.shouldConnect,
      [STORAGE_KEYS.URL]: desired.url,
    });
  }

  private handleMessage(message: WsEnvelope, socket: WebSocket): void {
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'hello_ack': {
        const ack = message.payload as HelloAckPayload | undefined;
        this.daemonVersion = ack?.daemonVersion ?? '';
        this.resetRetry(); // 握手成功，退避序列归零
        break;
      }
      case 'tool_call':
        void this.handleToolCall(message, socket);
        break;
      default:
        console.log('[ws] unhandled message type:', message.type);
    }
  }

  private async handleToolCall(message: WsEnvelope, socket: WebSocket): Promise<void> {
    // 结果只回给收到调用的那个连接：执行期间连接被替换的话，
    // daemon 侧已按代数清扫旧 pending，结果不能串到新连接上。
    const reply = (payload: ToolResultPayload): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      let text = JSON.stringify({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload,
      } satisfies WsEnvelope);
      if (utf8ByteLengthExceeds(text, this.maxMessageBytes)) {
        // 超限帧发出去只会被 daemon 拒收并断连（协议 §3.2）；
        // 改发干净的 result_too_large，连接保持不断（协议 §2.1）。
        text = JSON.stringify({
          type: 'tool_result',
          responseToRequestId: message.requestId,
          payload: {
            error: `result too large to deliver: ws transport limit exceeded (message exceeds ${this.maxMessageBytes} bytes)`,
            code: 'result_too_large',
          } satisfies ToolResultPayload,
        } satisfies WsEnvelope);
      }
      socket.send(text);
    };
    const payload = message.payload as ToolCallPayload | undefined;
    if (!payload?.name) {
      reply({ error: 'missing tool name' });
      return;
    }
    try {
      const data = await this.onToolCall(payload.name, payload.args || {});
      reply({ data } satisfies ToolResultPayload);
    } catch (err) {
      const result: ToolResultPayload = {
        error: (err as Error)?.message ?? String(err),
      };
      const te = err as { code?: string; details?: Record<string, unknown> };
      if (typeof te.code === 'string' && te.code) result.code = te.code;
      if (te.details) result.details = te.details;
      reply(result);
    }
  }

  private send(message: WsEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
