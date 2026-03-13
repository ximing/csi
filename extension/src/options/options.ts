import './options.css';
import { DEFAULT_RECONCILE_PERIOD_SECONDS, DEFAULT_WS_URL, STORAGE_KEYS } from '../shared/constants';

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
    // env 端口锁不被 3s 轮询冲掉，循环后单独处理
    if (el.id === 'cfg-port' && portEnvLocked) return;
    (el as HTMLInputElement | HTMLButtonElement).disabled = disabled;
  });
  // env 锁以标志位为准；离线时 cfgPort 仍然禁用
  cfgPort.disabled = portEnvLocked || disabled;
}

void refreshStatus();
setInterval(() => void refreshStatus(), 3000);

// ---------- daemon 设置区块 ----------

type ConfigSource = 'env' | 'config' | 'default';

interface ConfigResponse {
  port: { value: number; source: ConfigSource };
  log_retention_days: { value: number; source: ConfigSource };
  tool_timeout_seconds: { value: number; source: ConfigSource };
}

const cfgPort = document.getElementById('cfg-port') as HTMLInputElement;
const cfgLogDays = document.getElementById('cfg-log-days') as HTMLInputElement;
const cfgToolTimeout = document.getElementById('cfg-tool-timeout') as HTMLInputElement;
const portNote = document.getElementById('port-note')!;
const saveConfigButton = document.getElementById('btn-save-config') as HTMLButtonElement;
const restartButton = document.getElementById('btn-restart') as HTMLButtonElement;
const configResult = document.getElementById('config-result')!;
const configUnsupported = document.getElementById('config-unsupported')!;

// env 锁端口标志（CSI_PORT 锁定时不被 updateSettingsAvailability 轮询冲掉）
let portEnvLocked = false;

function showConfigResult(key: string, ok: boolean, subs?: string | string[]): void {
  configResult.className = ok ? 'result ok' : 'result fail';
  configResult.textContent = i18n(key, subs);
}

async function loadConfig(): Promise<void> {
  try {
    const resp = await fetch(`${await currentDaemonBase()}/config`, { signal: AbortSignal.timeout(2000) });
    if (resp.status === 404) throw new Error('unsupported');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const cfg = (await resp.json()) as ConfigResponse;
    cfgPort.value = String(cfg.port.value);
    cfgLogDays.value = String(cfg.log_retention_days.value);
    cfgToolTimeout.value = String(cfg.tool_timeout_seconds.value);
    if (cfg.port.source === 'env') {
      portEnvLocked = true;
      cfgPort.disabled = true;
      portNote.hidden = false;
      portNote.textContent = i18n('configPortEnvNote');
    }
  } catch {
    // 404（旧 daemon）或不可达：隐藏表单，提示不支持（不可达时状态区块已禁用控件）
    configUnsupported.hidden = false;
    configUnsupported.textContent = i18n('configUnsupported');
    document.getElementById('config-form')!.style.display = 'none';
  }
}

// 前端校验与 daemon 一致（daemon 仍是权威校验）。
function validateInputs(): string | null {
  const port = Number(cfgPort.value);
  const days = Number(cfgLogDays.value);
  const timeout = Number(cfgToolTimeout.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1-65535';
  if (!Number.isInteger(days) || days < 1 || days > 30) return 'log_retention_days must be 1-30';
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 600) return 'tool_timeout_seconds must be 5-600';
  return null;
}

let pendingRestartPort: number | null = null;

saveConfigButton.addEventListener('click', async () => {
  const invalid = validateInputs();
  if (invalid) {
    showConfigResult('configInvalid', false, invalid);
    return;
  }
  saveConfigButton.disabled = true;
  try {
    const patch: Record<string, number> = {
      log_retention_days: Number(cfgLogDays.value),
      tool_timeout_seconds: Number(cfgToolTimeout.value),
    };
    if (!portEnvLocked) patch.port = Number(cfgPort.value);
    const resp = await fetch(`${await currentDaemonBase()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(3000),
    });
    const body = (await resp.json()) as { success: boolean; error?: string; data?: { restart_required: boolean } };
    if (!body.success) {
      showConfigResult('configSaveFailed', false, body.error || 'unknown');
      return;
    }
    showConfigResult('configSaved', true);
    const portChanged = patch.port !== undefined && patch.port !== lastStatus?.port;
    pendingRestartPort = body.data?.restart_required && portChanged ? patch.port! : null;
    restartButton.hidden = pendingRestartPort === null;
  } catch (err) {
    showConfigResult('configSaveFailed', false, (err as Error).message);
  } finally {
    saveConfigButton.disabled = false;
  }
});

async function pollHealthz(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

restartButton.addEventListener('click', async () => {
  if (pendingRestartPort === null) return;
  const newPort = pendingRestartPort;
  const oldBase = await currentDaemonBase();
  restartButton.disabled = true;
  showConfigResult('restartInProgress', true);
  try {
    await fetch(`${oldBase}/restart`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    // 旧进程可能已经退出，不影响后续轮询
  }
  const newBase = `http://127.0.0.1:${newPort}`;
  if (await pollHealthz(newBase, 10_000)) {
    // 切换 WS URL 并让 background 重连（CONNECT 会落 storage）
    await chrome.runtime.sendMessage({ type: 'CONNECT', url: `ws://127.0.0.1:${newPort}/ws` });
    pendingRestartPort = null;
    restartButton.hidden = true;
    showConfigResult('restartOk', true, String(newPort));
    void refreshStatus();
  } else if (await pollHealthz(oldBase, 2_000)) {
    showConfigResult('restartFailedOldAlive', false);
  } else {
    showConfigResult('restartFailedDown', false);
  }
  restartButton.disabled = false;
});

void loadConfig();

// ---------- 插件设置区块 ----------

const reconcileSelect = document.getElementById('reconcile-period') as HTMLSelectElement;
const extResult = document.getElementById('ext-result')!;

async function loadExtSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RECONCILE_PERIOD);
  const seconds =
    (stored[STORAGE_KEYS.RECONCILE_PERIOD] as number | undefined) ?? DEFAULT_RECONCILE_PERIOD_SECONDS;
  reconcileSelect.value = String(seconds);
}

reconcileSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.RECONCILE_PERIOD]: Number(reconcileSelect.value) });
  extResult.className = 'result ok';
  extResult.textContent = i18n('extSaved');
});

void loadExtSettings();
