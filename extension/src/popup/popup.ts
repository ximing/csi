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
  const version = chrome.runtime.getManifest().version;
  document.getElementById('version-footer')!.textContent = i18n('versionFooter', version);
  document.getElementById('settings-link')!.textContent = i18n('settingsLink');
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
  const status = await sendMessage<StatusResponse>({ type: 'GET_STATUS' });
  renderStatus(status?.state ?? 'disconnected', status?.serverUrl ?? '');
}

connectButton.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim() || DEFAULT_WS_URL;
  const request: ConnectRequest = { type: 'CONNECT', url };
  await sendMessage(request);
  await refreshStatus();
});

disconnectButton.addEventListener('click', async () => {
  await sendMessage({ type: 'DISCONNECT' });
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
  }
});

document.getElementById('settings-link')!.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});
