/** Default daemon WebSocket endpoint (protocol §1). */
export const DEFAULT_WS_URL = 'ws://127.0.0.1:10088/ws';

/** chrome.alarms name used to reconcile desired vs actual WS state (protocol §3.1). */
export const RECONCILE_ALARM = 'csi-reconcile';

/** Default reconcile period in seconds (protocol §3.1). Chrome alarms floor is 30s. */
export const DEFAULT_RECONCILE_PERIOD_SECONDS = 30;

/** Give up on a half-open WebSocket after this long. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Storage keys for connection intent, persisted across service-worker restarts. */
export const STORAGE_KEYS = {
  SHOULD_CONNECT: 'ws_should_connect',
  URL: 'local_url',
  /** Reconcile period setting (seconds; 0 = auto-reconnect off). */
  RECONCILE_PERIOD: 'reconcile_period_seconds',
} as const;
