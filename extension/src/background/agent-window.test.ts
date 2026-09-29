import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installChrome, resetChromeState } from './test-chrome';
installChrome();
const { NavigateTool } = await import('./tools/navigate');
beforeEach(() => { resetChromeState(); });
afterEach(() => vi.restoreAllMocks());
it('默认直接在当前普通窗口创建标签', async () => {
  vi.spyOn(chrome.windows, 'getLastFocused').mockResolvedValue({ id: 42, type: 'normal' } as chrome.windows.Window);
  const create = vi.spyOn(chrome.tabs, 'create');
  await new NavigateTool().execute({ url: 'https://example.com', _session: 'test' }, { tabId: 0, documentEpoch: 0 });
  expect(create).toHaveBeenCalledWith({ url: 'https://example.com', active: false, windowId: 42 });
});

it('所有 session 并发共用独立窗口，worker 重启后恢复，关闭后重建', async () => {
  const saved: Record<string, number> = {};
  vi.spyOn(chrome.storage.local, 'get').mockImplementation(async () => ({ agentIndependentWindow: true }));
  const sessionStore = { get: vi.fn(async (key: string) => ({ [key]: saved[key] })), set: vi.fn(async (data) => { Object.assign(saved, data); }) };
  const windows = new Map<number, chrome.windows.Window>();
  const create = vi.fn(async (opts) => {
    const id = 100 + windows.size;
    const win = { id, type: 'normal', tabs: [{ id: id + 1000, windowId: id, url: opts.url }] } as chrome.windows.Window;
    windows.set(id, win);
    return win;
  });
  vi.stubGlobal('chrome', { ...chrome, storage: { ...chrome.storage, session: sessionStore }, windows: {
    ...chrome.windows, create, get: vi.fn(async (id) => { if (!windows.has(id)) throw new Error('closed'); return windows.get(id); }),
  } });
  try {
    let { createAgentTab } = await import('./agent-window');
    await Promise.all([createAgentTab('https://a.example'), createAgentTab('https://other.example')]);
    expect(create).toHaveBeenCalledTimes(1);
    const tabs = vi.spyOn(chrome.tabs, 'create');
    vi.resetModules();
    ({ createAgentTab } = await import('./agent-window'));
    await createAgentTab('https://b.example');
    expect(create).toHaveBeenCalledTimes(1);
    expect(tabs).toHaveBeenCalledWith({ url: 'https://b.example', active: false, windowId: 100 });
    await createAgentTab('https://a.example');
    expect(create).toHaveBeenCalledTimes(1);
    windows.delete(100);
    await createAgentTab('https://c.example');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith({ url: 'https://c.example', type: 'normal', focused: false });
  } finally { vi.unstubAllGlobals(); }
});

it('没有普通窗口时直接创建含目标页面的窗口', async () => {
  const { createAgentTab } = await import('./agent-window');
  vi.spyOn(chrome.windows, 'getLastFocused').mockRejectedValue(new Error('no windows'));
  const create = vi.fn(async () => ({ id: 2, tabs: [{ id: 20 }] }));
  vi.stubGlobal('chrome', { ...chrome, windows: { ...chrome.windows, create } });
  try {
    expect(await createAgentTab('https://a.example')).toEqual({ id: 20 });
    expect(create).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
