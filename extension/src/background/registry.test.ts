import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTab,
  debuggerCalls,
  fireRemoved,
  installChrome,
  resetChromeState,
  tabsRemoved,
} from './test-chrome';
import { ToolError } from './tool-error';

installChrome();

const { registerAllTools, dispatchTool, resolveTabTarget } = await import('./registry');
registerAllTools();

describe('dispatchTool targeting', () => {
  beforeEach(() => {
    resetChromeState();
    addTab({ id: 10, url: 'https://a.example', title: 'A', status: 'complete' });
    addTab({ id: 20, url: 'https://b.example', title: 'B', status: 'complete' });
    addTab({ id: 99, url: 'https://user.example', title: 'User', status: 'complete', active: true });
    debuggerCalls.length = 0;
    tabsRemoved.length = 0;
  });

  it('stale _tabId does not query the active tab', async () => {
    await expect(
      resolveTabTarget({ _tabId: 123, _session: 's' }),
    ).rejects.toMatchObject({ code: 'stale_target' });
  });

  it('_tabId 0 is no_session_target and does not snapshot', async () => {
    try {
      await dispatchTool('snapshot', { _tabId: 0, _session: 's', _tabIds: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('no_session_target');
    }
    expect(debuggerCalls.filter((c) => c.method === 'Accessibility.getFullAXTree')).toHaveLength(0);
  });

  it('different tab tools may overlap', async () => {
    const original = chrome.debugger.sendCommand;
    let active = 0;
    let max = 0;
    let release10!: () => void;
    const gate10 = new Promise<void>((r) => {
      release10 = r;
    });
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = (async (
      debuggee: { tabId: number },
      method: string,
    ) => {
      debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
      if (debuggee.tabId === 10 && method === 'Input.insertText') {
        active++;
        max = Math.max(max, active);
        await gate10;
        active--;
      }
      return {};
    }) as typeof chrome.debugger.sendCommand;

    const a = dispatchTool('key_type', { text: 'a', _tabId: 10, _tabIds: [10], _session: 's' });
    const b = dispatchTool('key_type', { text: 'b', _tabId: 20, _tabIds: [20], _session: 't' });
    await b;
    expect(max).toBeGreaterThanOrEqual(1);
    release10();
    await a;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
  });

  it('same tab tools do not overlap', async () => {
    const original = chrome.debugger.sendCommand;
    let active = 0;
    let max = 0;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = (async (
      debuggee: { tabId: number },
      method: string,
    ) => {
      active++;
      max = Math.max(max, active);
      if (method === 'Runtime.evaluate' || method === 'Accessibility.getFullAXTree') {
        await new Promise((r) => setTimeout(r, 30));
      }
      active--;
      debuggerCalls.push({ tabId: debuggee.tabId, method, t: Date.now() });
      return {};
    }) as typeof chrome.debugger.sendCommand;

    const a = dispatchTool('key_type', { text: 'a', _tabId: 10, _tabIds: [10], _session: 's' });
    const b = dispatchTool('key_type', { text: 'b', _tabId: 10, _tabIds: [10], _session: 's' });
    await Promise.all([a, b]);
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
    expect(max).toBe(1);
  });

  it('close_session with empty owned and borrowed current does not remove the user tab', async () => {
    const result = (await dispatchTool('close_session', {
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { closed: number };
    expect(result.closed).toBe(0);
    expect(tabsRemoved).toEqual([]);
  });

  it('close_tab refuses a borrowed target', async () => {
    const result = (await dispatchTool('close_tab', {
      _tabId: 99,
      _tabIds: [10],
      _borrowed: true,
      _session: 's',
    })) as { closed: boolean; reason?: string };
    expect(result.closed).toBe(false);
    expect(result.reason).toContain('borrowed');
    expect(tabsRemoved).toEqual([]);
  });

  it('close_tab closes an owned tab even if _borrowed is wrongly true', async () => {
    const result = (await dispatchTool('close_tab', {
      _tabId: 10,
      _tabIds: [10],
      _borrowed: true,
      _session: 's',
    })) as { closed: boolean };
    expect(result.closed).toBe(true);
    expect(tabsRemoved).toEqual([10]);
  });

  it('list_tabs does not put borrowed current into tabs', async () => {
    const result = (await dispatchTool('list_tabs', {
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { tabs: unknown[]; currentTarget?: { tabId: number; borrowed: boolean } };
    expect(result.tabs).toEqual([]);
    expect(result.currentTarget?.tabId).toBe(99);
    expect(result.currentTarget?.borrowed).toBe(true);
  });

  it('navigate on borrowed current creates a new tab and does not CDP the user tab', async () => {
    debuggerCalls.length = 0;
    const result = (await dispatchTool('navigate', {
      url: 'https://owned.example',
      _tabId: 99,
      _tabIds: [],
      _borrowed: true,
      _session: 's',
    })) as { tabId: number; borrowed?: boolean };
    expect(result.tabId).not.toBe(99);
    expect(result.borrowed).toBeUndefined();
    const nav = debuggerCalls.filter((c) => c.method === 'Page.navigate' || c.method === 'Page.reload');
    expect(nav.every((c) => c.tabId !== 99)).toBe(true);
  });

  it('find_tab active:true on an owned tab returns borrowed:false', async () => {
    addTab({ id: 10, url: 'https://a.example/path', title: 'A', active: true, status: 'complete' });
    const result = (await dispatchTool('find_tab', {
      url: 'https://a.example',
      active: true,
      _tabId: 10,
      _tabIds: [10],
      _session: 's',
    })) as { borrowed: boolean; tabId: number };
    expect(result.tabId).toBe(10);
    expect(result.borrowed).toBe(false);
  });

  it('tabs.onRemoved for B does not clear A refs', async () => {
    const { assignRef, lookupRef } = await import('./refs');
    assignRef(10, 111, 'button', 'A');
    assignRef(20, 222, 'button', 'B');
    fireRemoved(20);
    expect(lookupRef(10, '@e1')?.backendDOMNodeId).toBe(111);
    expect(lookupRef(20, '@e1')).toBeUndefined();
  });
});
