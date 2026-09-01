// @vitest-environment jsdom
// popup 页单测：连接状态渲染、CONNECT/DISCONNECT/TEST_CONNECTION 按钮行为、
// CONNECTION_STATE_CHANGED 推送处理与设置入口。
// chrome fake 以 src/background/test-chrome.ts 的 installChrome 为底座，
// popup 需要的 i18n / runtime.sendMessage / onMessage / openOptionsPage 在本文件局部补齐。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../background/test-chrome';
import { DEFAULT_WS_URL } from '../shared/constants';
import type { RuntimeRequest } from '../shared/messages';

// ---- i18n fake：缺失 key 返回 ''（chrome 行为），$n 用 subs 替换 ----
const i18nMessages: Record<string, string> = {
  popupTitle: 'CSI',
  serverUrlLabel: 'Daemon 地址',
  connectButton: '连接',
  disconnectButton: '断开',
  testButton: '测试连接',
  versionFooter: 'v$1',
  settingsLink: '设置',
  statusConnected: '已连接',
  statusConnecting: '连接中',
  statusDisconnected: '已断开',
  testTesting: '测试中…',
  testOk: '测试成功',
  testFailed: '测试失败',
};

function fakeGetMessage(key: string, subs?: string | string[]): string {
  const msg = i18nMessages[key];
  if (msg === undefined) return '';
  const arr = Array.isArray(subs) ? subs : subs !== undefined ? [subs] : [];
  return msg.replace(/\$(\d)/g, (_, n: string) => arr[Number(n) - 1] ?? '');
}

// ---- 可编程的 runtime.sendMessage / onMessage ----
let sendMessageHandler: (message: RuntimeRequest) => unknown;
let sentMessages: RuntimeRequest[];
let onMessageListeners: ((message: unknown) => void)[];
let optionsOpened: boolean;

// popup.ts 顶层直接执行副作用，每个用例重建 DOM + chrome 状态后重新 import。
async function importPopup(): Promise<void> {
  vi.resetModules();
  await import('./popup');
}

function popupDom(): void {
  document.body.innerHTML = `
    <h1 id="title"></h1>
    <span id="status-dot" class="dot dot-off"></span>
    <span id="status-text">—</span>
    <label id="server-url-label" for="server-url"></label>
    <input id="server-url" type="text">
    <button id="btn-connect" type="button"></button>
    <button id="btn-disconnect" type="button"></button>
    <button id="btn-test" type="button"></button>
    <p id="test-result" class="test-result"></p>
    <a id="settings-link" href="#"></a>
    <footer id="version-footer"></footer>
  `;
}

beforeEach(() => {
  popupDom();
  installChrome();
  const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
  sentMessages = [];
  onMessageListeners = [];
  optionsOpened = false;
  sendMessageHandler = () => undefined;
  Object.assign(chromeObj, {
    i18n: { getMessage: fakeGetMessage },
  });
  Object.assign(chromeObj.runtime as Record<string, unknown>, {
    sendMessage: async (message: RuntimeRequest) => {
      sentMessages.push(message);
      return sendMessageHandler(message);
    },
    onMessage: { addListener: (fn: (message: unknown) => void) => onMessageListeners.push(fn) },
    openOptionsPage: async () => {
      optionsOpened = true;
    },
  });
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('popup 静态文案', () => {
  it('初始化时写入 i18n 文案与版本号', async () => {
    await importPopup();
    expect(document.getElementById('title')!.textContent).toBe('CSI');
    expect(document.getElementById('server-url-label')!.textContent).toBe('Daemon 地址');
    expect(document.getElementById('btn-connect')!.textContent).toBe('连接');
    expect(document.getElementById('btn-disconnect')!.textContent).toBe('断开');
    expect(document.getElementById('btn-test')!.textContent).toBe('测试连接');
    expect(document.getElementById('settings-link')!.textContent).toBe('设置');
    // getManifest 由 test-chrome 提供（0.7.0）
    expect(document.getElementById('version-footer')!.textContent).toBe('v0.7.0');
  });

  it('i18n 缺失 key 时回退为 key 本身', async () => {
    delete i18nMessages.serverUrlLabel;
    await importPopup();
    expect(document.getElementById('server-url-label')!.textContent).toBe('serverUrlLabel');
  });
});

describe('refreshStatus / renderStatus', () => {
  it('根据 GET_STATUS 响应渲染连接状态与 URL', async () => {
    sendMessageHandler = () => ({ state: 'connected', serverUrl: 'ws://127.0.0.1:9999/ws' });
    await importPopup();
    const input = document.getElementById('server-url') as HTMLInputElement;
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connected');
    expect(document.getElementById('status-text')!.textContent).toBe('已连接');
    expect(input.value).toBe('ws://127.0.0.1:9999/ws');
    expect(sentMessages).toEqual([{ type: 'GET_STATUS' }]);
  });

  it('footer 显示 daemon 版本；major.minor 不一致时追加错配警告', async () => {
    sendMessageHandler = () => ({ state: 'connected', serverUrl: 'ws://127.0.0.1:9999/ws', daemonVersion: '0.6.0' });
    await importPopup();
    await vi.waitFor(() => {
      const footer = document.getElementById('version-footer')!.textContent!;
      // i18n fake 没有 versionMismatch，靠 popup.ts 的 `|| key` 兜底拿到 key 本身
      expect(footer).toBe('v0.7.0 · daemon 0.6.0 — versionMismatch');
    });
  });

  it('major.minor 一致时 footer 不带警告', async () => {
    sendMessageHandler = () => ({ state: 'connected', serverUrl: 'ws://127.0.0.1:9999/ws', daemonVersion: '0.7.3' });
    await importPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('version-footer')!.textContent).toBe('v0.7.0 · daemon 0.7.3');
    });
  });

  it('GET_STATUS 无 daemonVersion 时 footer 只显示扩展版本', async () => {
    sendMessageHandler = () => ({ state: 'disconnected', serverUrl: '' });
    await importPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('version-footer')!.textContent).toBe('v0.7.0');
    });
  });

  it('connecting 状态与空 serverUrl 时不覆盖已有输入', async () => {
    sendMessageHandler = () => ({ state: 'connecting', serverUrl: '' });
    await importPopup();
    const input = document.getElementById('server-url') as HTMLInputElement;
    input.value = 'ws://keep-me/ws';
    await importPopup();
    // 顶层 refreshStatus 拿到空 serverUrl 且输入非空 → 保留用户输入
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connecting');
    expect(document.getElementById('status-text')!.textContent).toBe('连接中');
    expect(input.value).toBe('ws://keep-me/ws');
  });

  it('状态响应缺字段时回退 disconnected + 默认 URL', async () => {
    sendMessageHandler = () => undefined;
    await importPopup();
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-disconnected');
    expect(document.getElementById('status-text')!.textContent).toBe('已断开');
    expect((document.getElementById('server-url') as HTMLInputElement).value).toBe(DEFAULT_WS_URL);
  });

  it('空 serverUrl 且输入为空时填入默认 URL', async () => {
    sendMessageHandler = () => ({ state: 'disconnected', serverUrl: '' });
    await importPopup();
    expect((document.getElementById('server-url') as HTMLInputElement).value).toBe(DEFAULT_WS_URL);
  });
});

describe('CONNECTION_STATE_CHANGED 推送', () => {
  it('收到推送后重渲染状态', async () => {
    sendMessageHandler = () => undefined;
    await importPopup();
    const fire = onMessageListeners[0]!;
    fire({ type: 'CONNECTION_STATE_CHANGED', state: 'connected', serverUrl: 'ws://push:1/ws' });
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connected');
    expect((document.getElementById('server-url') as HTMLInputElement).value).toBe('ws://push:1/ws');
  });

  it('非目标消息或字段不全时忽略', async () => {
    sendMessageHandler = () => undefined;
    await importPopup();
    const fire = onMessageListeners[0]!;
    fire({ type: 'SOMETHING_ELSE', state: 'connected', serverUrl: 'ws://x/ws' });
    fire({ type: 'CONNECTION_STATE_CHANGED', serverUrl: 'ws://x/ws' }); // 缺 state
    fire({ type: 'CONNECTION_STATE_CHANGED', state: 'connected' }); // 缺 serverUrl
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-disconnected');
  });
});

describe('连接 / 断开按钮', () => {
  it('点击 Connect 发送 CONNECT（trim 输入）并刷新状态', async () => {
    const statuses: unknown[] = [
      { state: 'disconnected', serverUrl: '' },
      { state: 'connected', serverUrl: 'ws://127.0.0.1:1234/ws' },
    ];
    sendMessageHandler = (msg) => (msg.type === 'GET_STATUS' ? statuses.shift() : undefined);
    await importPopup();
    const input = document.getElementById('server-url') as HTMLInputElement;
    input.value = '  ws://127.0.0.1:1234/ws  ';
    document.getElementById('btn-connect')!.click();
    await vi.waitFor(() => {
      expect(sentMessages).toEqual([
        { type: 'GET_STATUS' },
        { type: 'CONNECT', url: 'ws://127.0.0.1:1234/ws' },
        { type: 'GET_STATUS' },
      ]);
    });
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connected');
  });

  it('输入为空时 CONNECT 回退默认 URL', async () => {
    sendMessageHandler = () => undefined;
    await importPopup();
    (document.getElementById('server-url') as HTMLInputElement).value = '   ';
    document.getElementById('btn-connect')!.click();
    await vi.waitFor(() => {
      expect(sentMessages).toContainEqual({ type: 'CONNECT', url: DEFAULT_WS_URL });
    });
  });

  it('点击 Disconnect 发送 DISCONNECT 并刷新', async () => {
    const statuses: unknown[] = [
      { state: 'connected', serverUrl: 'ws://a/ws' },
      { state: 'disconnected', serverUrl: '' },
    ];
    sendMessageHandler = (msg) => (msg.type === 'GET_STATUS' ? statuses.shift() : undefined);
    await importPopup();
    document.getElementById('btn-disconnect')!.click();
    await vi.waitFor(() => {
      expect(sentMessages).toEqual([
        { type: 'GET_STATUS' },
        { type: 'DISCONNECT' },
        { type: 'GET_STATUS' },
      ]);
    });
    expect(document.getElementById('status-text')!.textContent).toBe('已断开');
  });

  it('CONNECT/DISCONNECT 发送 reject 时不逃逸 unhandledRejection', async () => {
    sendMessageHandler = (msg) => {
      if (msg.type === 'GET_STATUS') return { state: 'disconnected', serverUrl: '' };
      throw new Error('boom');
    };
    await importPopup();
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      document.getElementById('btn-connect')!.click();
      document.getElementById('btn-disconnect')!.click();
      // 给微任务队列排空的时间；有 catch 时不会有 rejection 逃逸。
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('CONNECT 发送 reject 后仍刷新状态：不定格在旧的 connected 显示', async () => {
    const statuses: unknown[] = [
      { state: 'connected', serverUrl: 'ws://a/ws' },
      { state: 'disconnected', serverUrl: '' },
    ];
    sendMessageHandler = (msg) => {
      if (msg.type === 'GET_STATUS') return statuses.shift();
      throw new Error('Extension context invalidated');
    };
    await importPopup();
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connected');
    document.getElementById('btn-connect')!.click();
    // CONNECT 失败也要 refreshStatus：第二次 GET_STATUS 把真实状态渲染出来
    await vi.waitFor(() => {
      expect(document.getElementById('status-dot')!.className).toBe('dot dot-disconnected');
    });
    expect(sentMessages).toEqual([
      { type: 'GET_STATUS' },
      { type: 'CONNECT', url: 'ws://a/ws' },
      { type: 'GET_STATUS' },
    ]);
  });
});

describe('测试连接按钮', () => {
  it('成功：结果区标 ok 并刷新状态', async () => {
    const statuses: unknown[] = [
      { state: 'disconnected', serverUrl: '' },
      { state: 'connected', serverUrl: 'ws://ok/ws' },
    ];
    sendMessageHandler = (msg) => (msg.type === 'TEST_CONNECTION' ? { ok: true } : statuses.shift());
    await importPopup();
    document.getElementById('btn-test')!.click();
    await vi.waitFor(() => {
      expect(document.getElementById('test-result')!.className).toBe('test-result ok');
    });
    expect(document.getElementById('test-result')!.textContent).toBe('测试成功');
    expect((document.getElementById('btn-test') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('status-dot')!.className).toBe('dot dot-connected');
  });

  it('输入为空时测试按钮回退默认 URL', async () => {
    const urls: string[] = [];
    sendMessageHandler = (msg) => {
      if (msg.type === 'TEST_CONNECTION') {
        urls.push((msg as { url: string }).url);
        return { ok: true };
      }
      return undefined;
    };
    await importPopup();
    (document.getElementById('server-url') as HTMLInputElement).value = '';
    document.getElementById('btn-test')!.click();
    await vi.waitFor(() => {
      expect(urls).toEqual([DEFAULT_WS_URL]);
    });
  });

  it('失败：结果区标 fail', async () => {
    sendMessageHandler = (msg) => (msg.type === 'TEST_CONNECTION' ? { ok: false } : undefined);
    await importPopup();
    document.getElementById('btn-test')!.click();
    await vi.waitFor(() => {
      expect(document.getElementById('test-result')!.className).toBe('test-result fail');
    });
    expect(document.getElementById('test-result')!.textContent).toBe('测试失败');
    expect((document.getElementById('btn-test') as HTMLButtonElement).disabled).toBe(false);
  });

  it('发送抛异常时结果区标 fail、按钮恢复可用，且不逃逸 unhandledRejection', async () => {
    sendMessageHandler = (msg) => {
      if (msg.type === 'TEST_CONNECTION') throw new Error('boom');
      return undefined;
    };
    await importPopup();
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      document.getElementById('btn-test')!.click();
      await vi.waitFor(() => {
        expect((document.getElementById('btn-test') as HTMLButtonElement).disabled).toBe(false);
      });
      // catch 分支应把结果区标为失败，而不是永远停留在「测试中…」
      expect(document.getElementById('test-result')!.className).toBe('test-result fail');
      expect(document.getElementById('test-result')!.textContent).toBe('测试失败');
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('设置入口', () => {
  it('点击设置链接打开选项页并阻止默认导航', async () => {
    sendMessageHandler = () => undefined;
    await importPopup();
    const link = document.getElementById('settings-link') as HTMLAnchorElement;
    const event = new MouseEvent('click', { cancelable: true, bubbles: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(optionsOpened).toBe(true);
  });
});
