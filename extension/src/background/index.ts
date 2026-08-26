/**
 * Background service worker entry: registers the 21 tools, starts the
 * daemon WebSocket client, wires the reconcile alarm, and answers popup
 * runtime messages.
 */
import { dispatchTool, registerAllTools, toolNames } from './registry';
import { WsClient } from './ws-client';
import type { ConnectionStateChangedMessage, ToolArgs } from '../shared/messages';

registerAllTools();

const wsClient = new WsClient({
  onToolCall: (name, args) => dispatchTool(name, args as ToolArgs),
  tools: toolNames(),
  onConnectionStateChange: (state, serverUrl) => {
    const message: ConnectionStateChangedMessage = { type: 'CONNECTION_STATE_CHANGED', state, serverUrl };
    // No popup is normally open, so ignoring its absent receiver is expected.
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  },
});

const startup = wsClient.start();
void startup.catch((err) => console.error('[ws] failed to start:', err));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (wsClient.isReconcileAlarm(alarm.name)) {
    void wsClient.reconcile();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATUS':
          // A freshly woken service worker must reconcile persisted intent
          // before reporting its state, otherwise the popup sees stale "disconnected".
          await startup;
          sendResponse({
            connected: wsClient.isConnected(),
            state: wsClient.getConnectionState(),
            serverUrl: wsClient.getServerUrl(),
          });
          break;
        case 'CONNECT':
          await wsClient.connect(message.url);
          sendResponse({ success: true });
          break;
        case 'DISCONNECT':
          await wsClient.disconnect();
          sendResponse({ success: true });
          break;
        case 'TEST_CONNECTION':
          sendResponse(await wsClient.testConnection(message.url));
          break;
        default:
          sendResponse({ error: `unknown type: ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ error: (err as Error).message });
    }
  })();
  return true; // async sendResponse
});
