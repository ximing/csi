/**
 * Wire-format types for the daemon <-> extension WebSocket protocol (§3)
 * and the popup <-> background runtime messages.
 */

// ---------- WebSocket protocol (docs/protocol.md §3) ----------

export interface WsEnvelope {
  type: string;
  requestId?: string;
  responseToRequestId?: string;
  payload?: unknown;
}

export interface HelloPayload {
  extensionVersion: string;
}

export interface ToolCallPayload {
  name: string;
  args?: ToolArgs;
}

export interface ToolResultPayload {
  data?: unknown;
  error?: string;
}

/** Tool args are free-form plus the daemon-injected session fields (§3.4). */
export interface ToolArgs {
  _session?: string;
  _tabId?: number;
  _tabIds?: number[];
  [key: string]: unknown;
}

// ---------- popup <-> background runtime messages ----------

export interface StatusRequest {
  type: 'GET_STATUS';
}

export interface StatusResponse {
  connected: boolean;
  serverUrl: string;
  error?: string;
}

export interface ConnectRequest {
  type: 'CONNECT';
  url: string;
}

export interface DisconnectRequest {
  type: 'DISCONNECT';
}

export interface TestConnectionRequest {
  type: 'TEST_CONNECTION';
  url: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  reason?: string;
  error?: string;
}

export interface SuccessResponse {
  success?: boolean;
  error?: string;
}

export type RuntimeRequest =
  | StatusRequest
  | ConnectRequest
  | DisconnectRequest
  | TestConnectionRequest;
