import './options.css';
import { DEFAULT_WS_URL, STORAGE_KEYS } from '../shared/constants';

const i18n = (key: string, subs?: string | string[]): string => chrome.i18n.getMessage(key, subs) || key;

function applyStaticTexts(): void {
  document.getElementById('title')!.textContent = i18n('optionsTitle');
  document.getElementById('status-heading')!.textContent = i18n('statusHeading');
  document.getElementById('daemon-settings-heading')!.textContent = i18n('daemonSettingsHeading');
  document.getElementById('ext-settings-heading')!.textContent = i18n('extSettingsHeading');
  document.getElementById('dt-state')!.textContent = i18n('statusStateLabel');
  document.getElementById('dt-pid')!.textContent = i18n('statusPidLabel');
  document.getElementById('dt-version')!.textContent = i18n('statusVersionLabel');
  document.getElementById('dt-uptime')!.textContent = i18n('statusUptimeLabel');
  document.getElementById('dt-port')!.textContent = i18n('statusPortLabel');
  document.getElementById('dt-ext')!.textContent = i18n('statusExtLabel');
  document.getElementById('dt-sessions')!.textContent = i18n('statusSessionsLabel');
  document.getElementById('port-label')!.textContent = i18n('configPortLabel');
  document.getElementById('log-days-label')!.textContent = i18n('configLogDaysLabel');
  document.getElementById('tool-timeout-label')!.textContent = i18n('configToolTimeoutLabel');
  (document.getElementById('btn-save-config') as HTMLButtonElement).textContent = i18n('saveButton');
  (document.getElementById('btn-restart') as HTMLButtonElement).textContent = i18n('restartButton');
  document.getElementById('reconcile-label')!.textContent = i18n('reconcileLabel');
  document.getElementById('reconcile-30')!.textContent = i18n('reconcile30');
  document.getElementById('reconcile-60')!.textContent = i18n('reconcile60');
  document.getElementById('reconcile-off')!.textContent = i18n('reconcileOff');
  document.getElementById('version-footer')!.textContent = i18n('versionFooter', chrome.runtime.getManifest().version);
}

applyStaticTexts();

/** /status 响应（protocol §2.2）。 */
interface DaemonStatus {
  running: boolean;
  pid: number;
  version: string;
  extension_connected: boolean;
  extension_version: string;
  uptime_seconds: number;
  sessions: string[];
  port: number;
}

/** 从 ws://host:port/ws 推导 http://host:port；非法输入回退默认端口。 */
function daemonHttpBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl || DEFAULT_WS_URL);
    return `http://${u.host}`;
  } catch {
    return 'http://127.0.0.1:10088';
  }
}

async function currentDaemonBase(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.URL);
  return daemonHttpBase((stored[STORAGE_KEYS.URL] as string) || '');
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? i18n('uptimeFormat', [String(h), String(m), String(s)])
    : i18n('uptimeFormatShort', [String(m), String(s)]);
}

let lastStatus: DaemonStatus | null = null; // Task 9 重启流程要用端口信息

async function refreshStatus(): Promise<void> {
  const online = document.getElementById('status-online')!;
  const offline = document.getElementById('status-offline')!;
  try {
    const resp = await fetch(`${await currentDaemonBase()}/status`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const st = (await resp.json()) as DaemonStatus;
    lastStatus = st;
    online.hidden = false;
    offline.hidden = true;
    document.getElementById('status-state')!.textContent = i18n('statusRunning');
    document.getElementById('status-pid')!.textContent = String(st.pid);
    document.getElementById('status-version')!.textContent = st.version;
    document.getElementById('status-uptime')!.textContent = formatUptime(st.uptime_seconds);
    document.getElementById('status-port')!.textContent = String(st.port);
    document.getElementById('status-ext')!.textContent = st.extension_connected
      ? i18n('statusYes', st.extension_version || '?')
      : i18n('statusNo');
    document.getElementById('status-sessions')!.textContent = st.sessions.length ? st.sessions.join(', ') : '—';
  } catch {
    lastStatus = null;
    online.hidden = true;
    offline.hidden = false;
    offline.textContent = i18n('statusOffline');
  }
  updateSettingsAvailability();
}

// daemon 不在线时禁用设置表单（Task 9 的控件此时可能还不存在，判空跳过）。
function updateSettingsAvailability(): void {
  const form = document.getElementById('config-form');
  if (!form) return;
  const disabled = lastStatus === null;
  form.querySelectorAll('input, button').forEach((el) => {
    (el as HTMLInputElement | HTMLButtonElement).disabled = disabled;
  });
}

void refreshStatus();
setInterval(() => void refreshStatus(), 3000);
