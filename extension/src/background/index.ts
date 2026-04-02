/**
 * Background service worker entry: registers the 20 tools, starts the
 * daemon WebSocket client, wires the reconcile alarm, and answers popup
 * runtime messages.
 */
import { dispatchTool, registerAllTools, toolNames } from './registry';
import { WsClient } from './ws-client';
import type { ToolArgs } from '../shared/messages';

registerAllTools();

const wsClient = new WsClient({
  onToolCall: (name, args) => dispatchTool(name, args as ToolArgs),
  tools: toolNames(),
});

void wsClient.start();

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
          sendResponse({
            connected: wsClient.isConnected(),
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
