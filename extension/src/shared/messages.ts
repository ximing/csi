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
  tools?: string[];
}

export interface HelloAckPayload {
  daemonVersion?: string;
  tools?: string[];
}

export interface ToolCallPayload {
  name: string;
  args?: ToolArgs;
}

export interface ToolResultPayload {
  data?: unknown;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * artifact 信封（协议 §3.5）：工具结果超内联预算时放在
 * tool_result.payload.data 里，由 daemon 落盘后改写为客户端信封。
 * HTTP/MCP 客户端永不收到 artifact.data。
 */
export interface ArtifactEnvelope {
  artifact: {
    encoding: 'utf8';
    mimeType: string;
    suggestedName: string;
    data: string;
  };
  preview: string;
  sourceChars: number;
}

/** Tool args are free-form plus the daemon-injected session fields (§3.4). */
export interface ToolArgs {
  _session?: string;
  _tabId?: number;
  _tabIds?: number[];
  _borrowed?: boolean;
  [key: string]: unknown;
}

// ---------- popup <-> background runtime messages ----------

export interface StatusRequest {
  type: 'GET_STATUS';
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface StatusResponse {
  connected: boolean;
  state: ConnectionState;
  serverUrl: string;
  /** 最近一次 hello_ack 携带的 daemon 版本；未握手过时缺省。 */
  daemonVersion?: string;
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

/** Sent by the background worker whenever the primary WebSocket state changes. */
export interface ConnectionStateChangedMessage {
  type: 'CONNECTION_STATE_CHANGED';
  state: ConnectionState;
  serverUrl: string;
}

export type RuntimeRequest =
  | StatusRequest
  | ConnectRequest
  | DisconnectRequest
  | TestConnectionRequest;
