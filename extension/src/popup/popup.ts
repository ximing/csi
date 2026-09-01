import './popup.css';
import { DEFAULT_WS_URL } from '../shared/constants';
import type {
  ConnectionState,
  ConnectionStateChangedMessage,
  ConnectRequest,
  RuntimeRequest,
  StatusResponse,
  TestConnectionRequest,
  TestConnectionResponse,
} from '../shared/messages';

const i18n = (key: string, subs?: string | string[]): string => chrome.i18n.getMessage(key, subs) || key;

const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const connectButton = document.getElementById('btn-connect') as HTMLButtonElement;
const disconnectButton = document.getElementById('btn-disconnect') as HTMLButtonElement;
const testButton = document.getElementById('btn-test') as HTMLButtonElement;
const testResult = document.getElementById('test-result')!;

function applyStaticTexts(): void {
  document.getElementById('title')!.textContent = i18n('popupTitle');
  document.getElementById('server-url-label')!.textContent = i18n('serverUrlLabel');
  connectButton.textContent = i18n('connectButton');
  disconnectButton.textContent = i18n('disconnectButton');
  testButton.textContent = i18n('testButton');
  renderVersion();
  document.getElementById('settings-link')!.textContent = i18n('settingsLink');
}

// 最近一次 GET_STATUS 拿到的 daemon 版本，供 CONNECTION_STATE_CHANGED 推送重渲染用
let lastDaemonVersion = '';

/** footer 渲染：`ext X · daemon Y`，major.minor 不一致时追加错配警告。 */
function renderVersion(daemonVersion?: string): void {
  lastDaemonVersion = daemonVersion ?? '';
  const ext = chrome.runtime.getManifest().version;
  let text = i18n('versionFooter', ext);
  if (daemonVersion) {
    text += ` · daemon ${daemonVersion}`;
    const mm = (v: string): string => v.split('.').slice(0, 2).join('.');
    if (mm(ext) !== mm(daemonVersion)) text += ` — ${i18n('versionMismatch')}`;
  }
  document.getElementById('version-footer')!.textContent = text;
}

function sendMessage<T>(message: RuntimeRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function renderStatus(state: ConnectionState, serverUrl: string): void {
  statusDot.className = `dot dot-${state}`;
  statusText.textContent = i18n(
    state === 'connected' ? 'statusConnected' : state === 'connecting' ? 'statusConnecting' : 'statusDisconnected',
  );
  if (serverUrl) {
    serverUrlInput.value = serverUrl;
  } else if (!serverUrlInput.value) {
    serverUrlInput.value = DEFAULT_WS_URL;
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendMessage<StatusResponse>({ type: 'GET_STATUS' });
    renderStatus(status?.state ?? 'disconnected', status?.serverUrl ?? '');
    renderVersion(status?.daemonVersion);
  } catch {
    // SW 未就绪 / context 失效时按 disconnected 渲染（SW 都不在了，不可能是
    // connected），同时不让 rejection 逃成 unhandled。
    renderStatus('disconnected', '');
    renderVersion();
  }
}

connectButton.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim() || DEFAULT_WS_URL;
  const request: ConnectRequest = { type: 'CONNECT', url };
  try {
    await sendMessage(request);
  } catch {
    // SW 未就绪 / context 失效：吞掉避免 unhandled rejection，但仍要刷新状态，
    // 否则 popup 定格在旧显示（如 connected），失败在所有界面不可见。
  }
  await refreshStatus();
});

disconnectButton.addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'DISCONNECT' });
  } catch {
    // 同上。
  }
  await refreshStatus();
});

testButton.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim() || DEFAULT_WS_URL;
  testButton.disabled = true;
  testResult.className = 'test-result';
  testResult.textContent = i18n('testTesting');
  try {
    const request: TestConnectionRequest = { type: 'TEST_CONNECTION', url };
    const result = await sendMessage<TestConnectionResponse>(request);
    testResult.className = result?.ok ? 'test-result ok' : 'test-result fail';
    testResult.textContent = i18n(result?.ok ? 'testOk' : 'testFailed');
    await refreshStatus();
  } catch {
    testResult.className = 'test-result fail';
    testResult.textContent = i18n('testFailed');
  } finally {
    testButton.disabled = false;
  }
});

applyStaticTexts();
void refreshStatus();

chrome.runtime.onMessage.addListener((message: unknown) => {
  const stateChanged = message as Partial<ConnectionStateChangedMessage>;
  if (stateChanged.type === 'CONNECTION_STATE_CHANGED' && stateChanged.state && stateChanged.serverUrl !== undefined) {
    renderStatus(stateChanged.state, stateChanged.serverUrl);
    // 推送不带 daemonVersion：连接中沿用最近已知版本，断开则清掉
    renderVersion(stateChanged.state === 'connected' ? lastDaemonVersion || undefined : undefined);
  }
});

document.getElementById('settings-link')!.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});
