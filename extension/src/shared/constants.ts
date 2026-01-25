/** Default daemon WebSocket endpoint (protocol §1). */
export const DEFAULT_WS_URL = 'ws://127.0.0.1:10088/ws';

/** chrome.alarms name used to reconcile desired vs actual WS state (protocol §3.1). */
export const RECONCILE_ALARM = 'csi-reconcile';

/** Reconcile period in minutes (protocol §3.1). */
export const RECONCILE_PERIOD_MINUTES = 0.5;

/** Give up on a half-open WebSocket after this long. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Storage keys for connection intent, persisted across service-worker restarts. */
export const STORAGE_KEYS = {
  SHOULD_CONNECT: 'ws_should_connect',
  URL: 'local_url',
} as const;
