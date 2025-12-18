/**
 * WebSocket client to the daemon (protocol §3).
 *
 * Connection intent (`ws_should_connect`, `local_url`) is persisted in
 * chrome.storage.local so a suspended service worker can be reconciled by
 * the `webbridge-reconcile` alarm (every 0.5 min): if we should be
 * connected but aren't, reconnect.
 */
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_WS_URL,
  RECONCILE_ALARM,
  RECONCILE_PERIOD_MINUTES,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  HelloPayload,
  ToolCallPayload,
  ToolResultPayload,
  WsEnvelope,
} from '../shared/messages';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

interface DesiredState {
  shouldConnect: boolean;
  url: string;
}

export interface WsClientOptions {
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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

  constructor(options: WsClientOptions) {
    this.onToolCall = options.onToolCall;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getServerUrl(): string {
    return this.currentUrl;
  }

  isReconcileAlarm(alarmName: string): boolean {
    return alarmName === RECONCILE_ALARM;
  }

  async start(): Promise<void> {
    await chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: RECONCILE_PERIOD_MINUTES });
    await this.reconcile();
  }

  async connect(url: string): Promise<void> {
    await this.setDesired({ shouldConnect: true, url });
    await this.reconcile();
  }

  async disconnect(): Promise<void> {
    await this.setDesired({ shouldConnect: false, url: this.currentUrl });
    this.teardown();
  }

  async reconcile(): Promise<void> {
    const desired = await this.getDesired();
    if (!desired.shouldConnect) {
      if (this.state !== 'disconnected') this.teardown();
      return;
    }
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.openSocket(desired.url || DEFAULT_WS_URL);
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
    this.state = 'connecting';
    this.currentUrl = url;
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
      this.state = 'connected';
      this.clearConnectingTimer();
      console.log('[ws] connected to', url);
      const payload: HelloPayload = { extensionVersion: chrome.runtime.getManifest().version };
      this.send({ type: 'hello', payload });
    });

    socket.addEventListener('message', (event) => {
      try {
        this.handleMessage(JSON.parse(String(event.data)) as WsEnvelope);
      } catch (err) {
        console.error('[ws] invalid message:', err);
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.state = 'disconnected';
      this.clearConnectingTimer();
      console.log('[ws] disconnected');
    });

    socket.addEventListener('error', (event) => {
      console.error('[ws] error:', event);
    });
  }

  private teardown(): void {
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
    this.state = 'disconnected';
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

  private handleMessage(message: WsEnvelope): void {
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'hello_ack':
        break;
      case 'tool_call':
        void this.handleToolCall(message);
        break;
      default:
        console.log('[ws] unhandled message type:', message.type);
    }
  }

  private async handleToolCall(message: WsEnvelope): Promise<void> {
    const payload = message.payload as ToolCallPayload | undefined;
    if (!payload?.name) {
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { error: 'missing tool name' } satisfies ToolResultPayload,
      });
      return;
    }
    try {
      const data = await this.onToolCall(payload.name, payload.args || {});
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { data } satisfies ToolResultPayload,
      });
    } catch (err) {
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { error: (err as Error)?.message ?? String(err) } satisfies ToolResultPayload,
      });
    }
  }

  private send(message: WsEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
