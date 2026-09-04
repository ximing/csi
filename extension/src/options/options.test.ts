// @vitest-environment jsdom
// options 页单测：daemon /status 轮询与渲染、daemon 配置（/config GET/POST、端口 env 锁、
// 前端校验、restart 后 healthz 轮询）、以及插件 reconcile 周期设置。
// chrome fake 以 src/background/test-chrome.ts 的 installChrome 为底座，
// i18n / storage.local / runtime.sendMessage 在本文件局部补齐；fetch 全程 stub；
// options.ts 顶层的 3s 轮询与 pollHealthz 的 500ms 重试用 fake timers 驱动。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../background/test-chrome';
import { DEFAULT_RECONCILE_PERIOD_SECONDS, STORAGE_KEYS } from '../shared/constants';

// ---------- i18n fake：缺失 key 返回 ''（chrome 行为），$n 用 subs 替换 ----------
const BASE_I18N: Record<string, string> = {
  optionsTitle: 'CSI 设置',
  statusHeading: 'Daemon 状态',
  daemonSettingsHeading: 'Daemon 设置',
  extSettingsHeading: '插件设置',
  statusStateLabel: '状态',
  statusPidLabel: 'PID',
  statusVersionLabel: '版本',
  statusUptimeLabel: '运行时长',
  statusPortLabel: '端口',
  statusExtLabel: '扩展',
  statusSessionsLabel: '会话',
  configPortLabel: '端口',
  configLogDaysLabel: '日志保留天数',
  configToolTimeoutLabel: '工具超时（秒）',
  saveButton: '保存',
  restartButton: '重启 daemon',
  reconcileLabel: '自动重连周期',
  reconcile30: '30 秒',
  reconcile60: '60 秒',
  reconcileOff: '关闭',
  versionFooter: 'v$1',
  statusRunning: '运行中',
  statusYes: '已连接（$1）',
  statusNo: '未连接',
  statusOffline: 'daemon 未运行',
  configPortEnvNote: '端口由 CSI_PORT 环境变量锁定',
  configUnsupported: '当前 daemon 不支持在线配置',
  configInvalid: '配置无效：$1',
  configSaveFailed: '保存失败：$1',
  configSaved: '已保存',
  restartInProgress: '重启中…',
  restartOk: '已重启，新端口 $1',
  restartFailedOldAlive: '重启失败：旧进程仍在运行',
  restartFailedDown: '重启失败：daemon 未恢复',
  restartFailedExt: 'daemon 已重启到端口 $1，但扩展重连失败——请再次点击重启重试',
  extSaved: '已保存',
  uptimeFormat: '$1小时$2分$3秒',
  uptimeFormatShort: '$1分$2秒',
};

let i18nMessages: Record<string, string>;

function fakeGetMessage(key: string, subs?: string | string[]): string {
  const msg = i18nMessages[key];
  if (msg === undefined) return '';
  const arr = Array.isArray(subs) ? subs : subs !== undefined ? [subs] : [];
  return msg.replace(/\$(\d)/g, (_, n: string) => arr[Number(n) - 1] ?? '');
}

// ---------- fetch fake ----------
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type Resp =
  | FakeResponse
  | 'reject'
  | ((url: string, init?: RequestInit) => FakeResponse | Promise<FakeResponse>);

interface Routes {
  status?: Resp; // 默认在线 200
  getConfig?: Resp; // 默认 200 正常配置
  postConfig?: Resp; // 默认 {success:true, restart_required:false}
  restart?: Resp; // 默认 200
  healthz?: Resp; // 默认 200，按 url 区分新旧端口
}

const fetchCalls: { url: string; method: string; body?: string }[] = [];
let routeFetch: (url: string, init?: RequestInit) => FakeResponse | Promise<FakeResponse>;

function installRoutes(r: Routes = {}): void {
  const pick = (
    v: Resp | undefined,
    dflt: () => FakeResponse,
    url: string,
    init?: RequestInit,
  ): FakeResponse | Promise<FakeResponse> => {
    if (v === 'reject') return Promise.reject(new TypeError('fetch failed'));
    if (typeof v === 'function') return v(url, init);
    return v ?? dflt();
  };
  routeFetch = (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/status')) return pick(r.status, () => jsonResponse(daemonStatus()), url, init);
    if (url.endsWith('/config') && method === 'POST')
      return pick(r.postConfig, () => jsonResponse({ success: true, data: { restart_required: false } }), url, init);
    if (url.endsWith('/config')) return pick(r.getConfig, () => jsonResponse(daemonConfig()), url, init);
    if (url.endsWith('/restart')) return pick(r.restart, () => jsonResponse({}), url, init);
    if (url.endsWith('/healthz')) return pick(r.healthz, () => jsonResponse({}), url, init);
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  };
}

const fetchMock = async (input: unknown, init?: RequestInit): Promise<FakeResponse> => {
  const url = String(input);
  fetchCalls.push({
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  return routeFetch(url, init);
};

// ---------- daemon 响应样本 ----------
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

function daemonStatus(over: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    running: true,
    pid: 1234,
    version: '0.7.1',
    extension_connected: true,
    extension_version: '0.7.0',
    uptime_seconds: 3661, // 1小时1分1秒
    sessions: ['alpha', 'beta'],
    port: 10088,
    ...over,
  };
}

function daemonConfig(portSource: 'env' | 'config' | 'default' = 'config'): {
  port: { value: number; source: 'env' | 'config' | 'default' };
  log_retention_days: { value: number; source: 'config' };
  tool_timeout_seconds: { value: number; source: 'config' };
} {
  return {
    port: { value: 10088, source: portSource },
    log_retention_days: { value: 7, source: 'config' },
    tool_timeout_seconds: { value: 60, source: 'config' },
  };
}

// ---------- chrome 可编程状态 ----------
let storageData: Record<string, unknown>;
const storageSets: Record<string, unknown>[] = [];
let sentMessages: unknown[];

// ---------- DOM（与 options.html 的 id 对齐的最小结构） ----------
const OPTIONS_HTML = `
  <h1 id="title"></h1>
  <h2 id="status-heading"></h2>
  <div id="status-online" hidden>
    <dl>
      <dt id="dt-state"></dt><dd id="status-state"></dd>
      <dt id="dt-pid"></dt><dd id="status-pid"></dd>
      <dt id="dt-version"></dt><dd id="status-version"></dd>
      <dt id="dt-uptime"></dt><dd id="status-uptime"></dd>
      <dt id="dt-port"></dt><dd id="status-port"></dd>
      <dt id="dt-ext"></dt><dd id="status-ext"></dd>
      <dt id="dt-sessions"></dt><dd id="status-sessions"></dd>
    </dl>
  </div>
  <p id="status-offline" hidden></p>
  <h2 id="daemon-settings-heading"></h2>
  <p id="config-unsupported" hidden></p>
  <div id="config-form">
    <label id="port-label" for="cfg-port"></label>
    <input id="cfg-port" type="number">
    <p id="port-note" hidden></p>
    <label id="log-days-label" for="cfg-log-days"></label>
    <input id="cfg-log-days" type="number">
    <label id="tool-timeout-label" for="cfg-tool-timeout"></label>
    <input id="cfg-tool-timeout" type="number">
    <button id="btn-save-config" type="button"></button>
    <button id="btn-restart" type="button" hidden></button>
    <p id="config-result" class="result"></p>
  </div>
  <h2 id="ext-settings-heading"></h2>
  <label id="reconcile-label" for="reconcile-period"></label>
  <select id="reconcile-period">
    <option value="30" id="reconcile-30"></option>
    <option value="60" id="reconcile-60"></option>
    <option value="0" id="reconcile-off"></option>
  </select>
  <p id="ext-result" class="result"></p>
  <footer id="version-footer"></footer>
`;

/** 冲掉微任务队列并推进 0ms 定时器，让 import 触发的顶层异步逻辑跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** options.ts 顶层直接执行副作用：每个用例重建环境后重新 import。 */
async function importOptions(): Promise<void> {
  vi.resetModules();
  await import('./options');
  await flush();
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function input$(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function button$(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = OPTIONS_HTML;
  installChrome();
  i18nMessages = { ...BASE_I18N };
  storageData = {};
  storageSets.length = 0;
  sentMessages = [];
  fetchCalls.length = 0;
  const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
  Object.assign(chromeObj, {
    i18n: { getMessage: fakeGetMessage },
  });
  Object.assign(chromeObj.storage as Record<string, unknown>, {
    local: {
      get: async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
        if (typeof keys === 'string') return { [keys]: storageData[keys] };
        if (Array.isArray(keys))
          return Object.fromEntries(keys.map((k) => [k, storageData[k]])) as Record<string, unknown>;
        return { ...storageData };
      },
      set: async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(storageData, items);
        storageSets.push(items);
      },
    },
  });
  Object.assign(chromeObj.runtime as Record<string, unknown>, {
    sendMessage: async (message: unknown): Promise<undefined> => {
      sentMessages.push(message);
    },
  });
  installRoutes();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers(); // 每次重新 import 的 options 模块都会注册新的 3s 轮询
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('静态文案', () => {
  it('初始化时写入 i18n 文案与版本号', async () => {
    await importOptions();
    expect($('title').textContent).toBe('CSI 设置');
    expect($('status-heading').textContent).toBe('Daemon 状态');
    expect($('daemon-settings-heading').textContent).toBe('Daemon 设置');
    expect($('ext-settings-heading').textContent).toBe('插件设置');
    expect($('btn-save-config').textContent).toBe('保存');
    expect($('btn-restart').textContent).toBe('重启 daemon');
    expect($('reconcile-30').textContent).toBe('30 秒');
    expect($('reconcile-60').textContent).toBe('60 秒');
    expect($('reconcile-off').textContent).toBe('关闭');
    // getManifest 由 test-chrome 提供（0.7.0）
    expect($('version-footer').textContent).toBe('v0.7.0');
  });

  it('i18n 缺失 key 时回退为 key 本身', async () => {
    delete i18nMessages.statusHeading;
    await importOptions();
    expect($('status-heading').textContent).toBe('statusHeading');
  });
});

describe('状态轮询 refreshStatus', () => {
  it('在线时渲染全部状态字段并启用表单', async () => {
    await importOptions();
    expect($('status-online').hidden).toBe(false);
    expect($('status-offline').hidden).toBe(true);
    expect($('status-state').textContent).toBe('运行中');
    expect($('status-pid').textContent).toBe('1234');
    expect($('status-version').textContent).toBe('0.7.1');
    expect($('status-uptime').textContent).toBe('1小时1分1秒');
    expect($('status-port').textContent).toBe('10088');
    expect($('status-ext').textContent).toBe('已连接（0.7.0）');
    expect($('status-sessions').textContent).toBe('alpha, beta');
    expect(input$('cfg-port').disabled).toBe(false);
    expect(input$('cfg-log-days').disabled).toBe(false);
    expect(button$('btn-save-config').disabled).toBe(false);
  });

  it('运行时长不足 1 小时用短格式；扩展未连接；无会话显示占位符', async () => {
    installRoutes({
      status: jsonResponse(
        daemonStatus({
          uptime_seconds: 125,
          extension_connected: false,
          extension_version: '',
          sessions: [],
        }),
      ),
    });
    await importOptions();
    expect($('status-uptime').textContent).toBe('2分5秒');
    expect($('status-ext').textContent).toBe('未连接');
    expect($('status-sessions').textContent).toBe('—');
  });

  it('扩展已连接但版本为空时显示占位符', async () => {
    installRoutes({ status: jsonResponse(daemonStatus({ extension_version: '' })) });
    await importOptions();
    expect($('status-ext').textContent).toBe('已连接（?）');
  });

  it('/status 非 2xx 时显示离线并禁用表单', async () => {
    installRoutes({ status: jsonResponse({}, 500) });
    await importOptions();
    expect($('status-online').hidden).toBe(true);
    expect($('status-offline').hidden).toBe(false);
    expect($('status-offline').textContent).toBe('daemon 未运行');
    expect(input$('cfg-port').disabled).toBe(true);
    expect(button$('btn-save-config').disabled).toBe(true);
  });

  it('fetch 抛异常时同样显示离线', async () => {
    installRoutes({ status: 'reject' });
    await importOptions();
    expect($('status-offline').hidden).toBe(false);
    expect(input$('cfg-port').disabled).toBe(true);
  });

  it('每 3 秒轮询一次 /status', async () => {
    await importOptions();
    expect(fetchCalls.filter((c) => c.url.endsWith('/status')).length).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(fetchCalls.filter((c) => c.url.endsWith('/status')).length).toBe(2);
  });

  it('config-form 不在 DOM 时轮询不抛错（判空分支）', async () => {
    await importOptions();
    $('config-form').remove();
    installRoutes({ status: 'reject' });
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect($('status-offline').hidden).toBe(false);
  });
});

describe('daemon 地址推导', () => {
  it('storage 里的自定义 WS URL 推导出对应 HTTP base', async () => {
    storageData[STORAGE_KEYS.URL] = 'ws://127.0.0.1:9999/ws';
    await importOptions();
    expect(fetchCalls.some((c) => c.url === 'http://127.0.0.1:9999/status')).toBe(true);
  });

  it('非法 WS URL 回退默认端口', async () => {
    storageData[STORAGE_KEYS.URL] = 'not-a-url';
    await importOptions();
    expect(fetchCalls.some((c) => c.url === 'http://127.0.0.1:10088/status')).toBe(true);
  });
});

describe('配置加载 loadConfig', () => {
  it('成功时填充表单', async () => {
    await importOptions();
    expect(input$('cfg-port').value).toBe('10088');
    expect(input$('cfg-log-days').value).toBe('7');
    expect(input$('cfg-tool-timeout').value).toBe('60');
    expect($('port-note').hidden).toBe(true);
    expect($('config-unsupported').hidden).toBe(true);
  });

  it('端口来源为 env 时锁定端口输入并提示', async () => {
    installRoutes({ getConfig: jsonResponse(daemonConfig('env')) });
    await importOptions();
    expect(input$('cfg-port').disabled).toBe(true);
    expect($('port-note').hidden).toBe(false);
    expect($('port-note').textContent).toBe('端口由 CSI_PORT 环境变量锁定');
    // 其他输入不受 env 锁影响
    expect(input$('cfg-log-days').disabled).toBe(false);
    // 轮询触发的 updateSettingsAvailability 不冲掉 env 锁：cfg-port 保持禁用
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(input$('cfg-port').disabled).toBe(true);
    expect(input$('cfg-log-days').disabled).toBe(false);
  });

  it('/config 404（旧 daemon）时提示不支持并隐藏表单', async () => {
    installRoutes({ getConfig: jsonResponse({}, 404) });
    await importOptions();
    expect($('config-unsupported').hidden).toBe(false);
    expect($('config-unsupported').textContent).toBe('当前 daemon 不支持在线配置');
    expect($('config-form').style.display).toBe('none');
  });

  it('/config 非 2xx 与不可达时同样走不支持分支', async () => {
    installRoutes({ getConfig: jsonResponse({}, 503) });
    await importOptions();
    expect($('config-unsupported').hidden).toBe(false);
    expect($('config-form').style.display).toBe('none');

    document.body.innerHTML = OPTIONS_HTML;
    installRoutes({ getConfig: 'reject' });
    await importOptions();
    expect($('config-unsupported').hidden).toBe(false);
    expect($('config-form').style.display).toBe('none');
  });
});

describe('保存配置', () => {
  it('非法输入被前端校验拦下，不发 POST', async () => {
    await importOptions();
    const cases: [string, string, string][] = [
      ['cfg-port', '0', 'port must be 1-65535'],
      ['cfg-log-days', '31', 'log_retention_days must be 1-30'],
      ['cfg-tool-timeout', '1', 'tool_timeout_seconds must be 5-600'],
    ];
    for (const [id, value, message] of cases) {
      input$('cfg-port').value = '10088';
      input$('cfg-log-days').value = '7';
      input$('cfg-tool-timeout').value = '60';
      input$(id).value = value;
      $('btn-save-config').click();
      await flush();
      expect($('config-result').className).toBe('result fail');
      expect($('config-result').textContent).toBe(`配置无效：${message}`);
    }
    expect(fetchCalls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('保存成功且端口变化 + 需重启时出现重启按钮', async () => {
    installRoutes({ postConfig: jsonResponse({ success: true, data: { restart_required: true } }) });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    expect($('config-result').className).toBe('result ok');
    expect($('config-result').textContent).toBe('已保存');
    expect($('btn-restart').hidden).toBe(false);
    expect(button$('btn-save-config').disabled).toBe(false);
    const post = fetchCalls.find((c) => c.url.endsWith('/config') && c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({
      port: 20000,
      log_retention_days: 7,
      tool_timeout_seconds: 60,
    });
  });

  it('保存成功但无需重启时重启按钮保持隐藏', async () => {
    await importOptions(); // 默认 postConfig: restart_required false
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    expect($('config-result').textContent).toBe('已保存');
    expect($('btn-restart').hidden).toBe(true);
  });

  it('端口未变化时不进入重启流程', async () => {
    installRoutes({ postConfig: jsonResponse({ success: true, data: { restart_required: true } }) });
    await importOptions();
    input$('cfg-port').value = '10088'; // 与 lastStatus.port 相同
    $('btn-save-config').click();
    await flush();
    expect($('btn-restart').hidden).toBe(true);
  });

  it('端口被 env 锁定时 POST body 不带 port', async () => {
    installRoutes({
      getConfig: jsonResponse(daemonConfig('env')),
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
    });
    await importOptions();
    input$('cfg-log-days').value = '14';
    $('btn-save-config').click();
    await flush();
    const post = fetchCalls.find((c) => c.url.endsWith('/config') && c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({
      log_retention_days: 14,
      tool_timeout_seconds: 60,
    });
    // patch.port 为 undefined → 不进重启流程
    expect($('btn-restart').hidden).toBe(true);
  });

  it('daemon 返回 success:false 时显示失败信息', async () => {
    installRoutes({ postConfig: jsonResponse({ success: false, error: 'bad port' }) });
    await importOptions();
    $('btn-save-config').click();
    await flush();
    expect($('config-result').className).toBe('result fail');
    expect($('config-result').textContent).toBe('保存失败：bad port');
    expect(button$('btn-save-config').disabled).toBe(false);
  });

  it('success:false 且无 error 时回退 unknown', async () => {
    installRoutes({ postConfig: jsonResponse({ success: false }) });
    await importOptions();
    $('btn-save-config').click();
    await flush();
    expect($('config-result').textContent).toBe('保存失败：unknown');
  });

  it('POST 抛异常时显示失败信息并恢复按钮', async () => {
    installRoutes({ postConfig: 'reject' });
    await importOptions();
    $('btn-save-config').click();
    await flush();
    expect($('config-result').className).toBe('result fail');
    expect($('config-result').textContent).toBe('保存失败：fetch failed');
    expect(button$('btn-save-config').disabled).toBe(false);
  });
});

describe('重启流程', () => {
  it('无待重启端口时点击重启按钮无操作', async () => {
    await importOptions();
    $('btn-restart').click();
    await flush();
    expect(fetchCalls.some((c) => c.url.endsWith('/restart'))).toBe(false);
    expect(sentMessages).toEqual([]);
    expect($('config-result').textContent).toBe('');
  });

  it('新端口 healthz 就绪：发送 CONNECT 切换 WS URL 并提示成功', async () => {
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: (url) => (url.includes(':20000') ? jsonResponse({}) : jsonResponse({}, 503)),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    $('btn-restart').click();
    await flush();
    expect(fetchCalls.some((c) => c.url.endsWith('/restart') && c.method === 'POST')).toBe(true);
    expect(sentMessages).toContainEqual({ type: 'CONNECT', url: 'ws://127.0.0.1:20000/ws' });
    expect($('config-result').className).toBe('result ok');
    expect($('config-result').textContent).toBe('已重启，新端口 20000');
    expect($('btn-restart').hidden).toBe(true);
    expect(button$('btn-restart').disabled).toBe(false);
  });

  it('CONNECT 以 {error} 体成功 resolve（非 throw）→ 当重连失败，不得提示已重启成功', async () => {
    // background CONNECT 失败走 sendResponse({error})，Promise resolve 不 reject。
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: (url) => (url.includes(':20000') ? jsonResponse({}) : jsonResponse({}, 503)),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
    Object.assign(chromeObj.runtime as Record<string, unknown>, {
      sendMessage: async (message: unknown): Promise<{ error: string }> => {
        sentMessages.push(message);
        return { error: 'connect failed' };
      },
    });
    $('btn-restart').click();
    await flush();
    expect($('config-result').className).toBe('result fail');
    expect($('config-result').textContent).toBe(
      'daemon 已重启到端口 20000，但扩展重连失败——请再次点击重启重试',
    );
    expect(button$('btn-restart').disabled).toBe(false);
    expect($('btn-restart').hidden).toBe(false);
  });

  it('CONNECT 失败后 3s 状态轮询离线：重启按钮保持可点（pendingRestartPort 不被冲掉）', async () => {
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: (url) => (url.includes(':20000') ? jsonResponse({}) : jsonResponse({}, 503)),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
    Object.assign(chromeObj.runtime as Record<string, unknown>, {
      sendMessage: async (message: unknown): Promise<undefined> => {
        sentMessages.push(message);
        throw new Error('Extension context invalidated');
      },
    });
    $('btn-restart').click();
    await flush();
    expect($('btn-restart').hidden).toBe(false);
    expect(button$('btn-restart').disabled).toBe(false);
    // 旧 daemon 已死：轮询 /status 失败会 lastStatus=null，不得把重启按钮一并禁用。
    installRoutes({ status: jsonResponse({}, 503) });
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(button$('btn-restart').disabled).toBe(false);
    expect($('btn-restart').hidden).toBe(false);
  });

  it('新端口就绪但扩展 CONNECT 失败：提示重连失败、按钮恢复、pendingRestartPort 保留可重试', async () => {
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: (url) => (url.includes(':20000') ? jsonResponse({}) : jsonResponse({}, 503)),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    // 模拟 SW context 失效：sendMessage 拒绝（popup 同款场景，restart 也不能裸 await）
    const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
    Object.assign(chromeObj.runtime as Record<string, unknown>, {
      sendMessage: async (message: unknown): Promise<undefined> => {
        sentMessages.push(message);
        throw new Error('Extension context invalidated');
      },
    });
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      $('btn-restart').click();
      await flush();
      expect($('config-result').className).toBe('result fail');
      expect($('config-result').textContent).toBe(
        'daemon 已重启到端口 20000，但扩展重连失败——请再次点击重启重试',
      );
      expect(button$('btn-restart').disabled).toBe(false);
      expect($('btn-restart').hidden).toBe(false);
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('新端口起不来、旧进程仍存活：提示旧进程存活', async () => {
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: (url) => (url.includes(':20000') ? jsonResponse({}, 503) : jsonResponse({})),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    $('btn-restart').click();
    await vi.advanceTimersByTimeAsync(10_000); // 新端口 10s 轮询超时
    await flush();
    expect($('config-result').className).toBe('result fail');
    expect($('config-result').textContent).toBe('重启失败：旧进程仍在运行');
    expect($('btn-restart').hidden).toBe(false);
    expect(button$('btn-restart').disabled).toBe(false);
  });

  it('新旧端口都不可达：提示 daemon 未恢复', async () => {
    installRoutes({
      postConfig: jsonResponse({ success: true, data: { restart_required: true } }),
      healthz: jsonResponse({}, 503),
    });
    await importOptions();
    input$('cfg-port').value = '20000';
    $('btn-save-config').click();
    await flush();
    $('btn-restart').click();
    await vi.advanceTimersByTimeAsync(10_000); // 新端口 10s
    await vi.advanceTimersByTimeAsync(2_500); // 旧端口 2s
    await flush();
    expect($('config-result').textContent).toBe('重启失败：daemon 未恢复');
    expect(button$('btn-restart').disabled).toBe(false);
  });
});

describe('插件设置', () => {
  it('无存储值时 reconcile 周期回默认 30 秒', async () => {
    await importOptions();
    expect((document.getElementById('reconcile-period') as HTMLSelectElement).value).toBe(
      String(DEFAULT_RECONCILE_PERIOD_SECONDS),
    );
  });

  it('读取已存储的 reconcile 周期', async () => {
    storageData[STORAGE_KEYS.RECONCILE_PERIOD] = 60;
    await importOptions();
    expect((document.getElementById('reconcile-period') as HTMLSelectElement).value).toBe('60');
  });

  it('切换周期时写入 storage 并提示已保存', async () => {
    await importOptions();
    const select = document.getElementById('reconcile-period') as HTMLSelectElement;
    select.value = '0';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(storageSets).toContainEqual({ [STORAGE_KEYS.RECONCILE_PERIOD]: 0 });
    expect($('ext-result').className).toBe('result ok');
    expect($('ext-result').textContent).toBe('已保存');
  });
});
