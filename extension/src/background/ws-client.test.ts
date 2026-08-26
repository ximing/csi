import { beforeEach, describe, expect, it } from 'vitest';
import { WsClient } from './ws-client';

type Listener = () => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.emit('close');
  }

  send(): void {
    // The tested client only sends after the connection is open.
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
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
});
