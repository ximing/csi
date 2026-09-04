/**
 * find_tab 测试（协议 §4.2/§3.4）：
 * url 必填、host pattern 三种来源（URL 解析 / 通配符直通 / 非法 URL 兜底）、
 * active:true 借前台 tab（borrowed）、session 内搜索首个命中、
 * 已关 tab 跳过、无命中报错，以及命中后 attach + 走 per-tab 队列。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { FindTabTool } = await import('./find-tab');

const tool = new FindTabTool();
const ctx = { tabId: 0, documentEpoch: 0 };

beforeEach(() => {
  resetChromeState();
});

describe('find_tab 参数与 pattern', () => {
  it('缺 url 报错', async () => {
    await expect(tool.execute({ _session: 's' }, ctx)).rejects.toThrow('find_tab: url is required');
  });

  it('带通配符的 url 原样作为 pattern 使用', async () => {
    addTab({ id: 10, url: 'https://wild.example/x', active: true });
    const result = (await tool.execute(
      { url: '*://wild.example/*', active: true, _tabIds: [10], _session: 's' },
      ctx,
    )) as { tabId: number };
    expect(result.tabId).toBe(10);
  });

  it('非法 URL 走兜底：剥掉前导点当 host 用', async () => {
    addTab({ id: 10, url: 'https://dirty.example/x' });
    const result = (await tool.execute(
      { url: '..dirty.example', _tabIds: [10], _session: 's' },
      ctx,
    )) as { tabId: number; url: string };
    expect(result.tabId).toBe(10);
    expect(result.url).toBe('https://dirty.example/x');
  });
});

describe('find_tab active:true（借前台 tab）', () => {
  it('前台 tab 域名匹配时命中，borrowed = 不在 owned 集', async () => {
    addTab({ id: 10, url: 'https://owned.example', active: false });
    addTab({ id: 55, url: 'https://news.example/article', title: 'News', active: true });
    const result = (await tool.execute(
      { url: 'https://news.example/article', active: true, _tabIds: [10], _session: 's' },
      ctx,
    )) as { success: boolean; url: string; tabId: number; borrowed: boolean };
    expect(result).toEqual({
      success: true,
      url: 'https://news.example/article',
      tabId: 55,
      borrowed: true,
    });
    // 命中后通过 per-tab 队列 attach 了该 tab
    expect(debuggerCalls).toContainEqual(expect.objectContaining({ tabId: 55, method: 'Page.enable' }));
  });

  it('前台 tab 是别的域名时报错并提示用户没在看该页', async () => {
    addTab({ id: 10, url: 'https://owned.example', active: true });
    await expect(
      tool.execute({ url: 'https://other.example', active: true, _tabIds: [10], _session: 's' }, ctx),
    ).rejects.toThrow(/find_tab\(active:true\): no foreground tab matching/);
  });

  it('前台 tab 无 url（如还没提交导航）不算命中', async () => {
    addTab({ id: 10, active: true }); // url 缺失
    await expect(
      tool.execute({ url: 'https://any.example', active: true, _tabIds: [10], _session: 's' }, ctx),
    ).rejects.toThrow(/no foreground tab matching/);
  });

  it('没有前台 tab 时报错', async () => {
    addTab({ id: 10, url: 'https://owned.example', active: false });
    await expect(
      tool.execute({ url: 'https://owned.example', active: true, _tabIds: [10], _session: 's' }, ctx),
    ).rejects.toThrow(/no foreground tab matching/);
  });
});

describe('find_tab session 内搜索', () => {
  it('在 owned 集里按 host 找到第一个匹配（borrowed false），并 attach', async () => {
    addTab({ id: 10, url: 'https://first.example' });
    addTab({ id: 11, url: 'https://target.example/page' });
    addTab({ id: 12, url: 'https://target.example/other' }); // 同 host 的后续 tab 不抢先
    const result = (await tool.execute(
      { url: 'https://target.example/page', _tabIds: [10, 11, 12], _session: 's' },
      ctx,
    )) as { success: boolean; url: string; tabId: number; borrowed: boolean };
    expect(result).toEqual({
      success: true,
      url: 'https://target.example/page',
      tabId: 11,
      borrowed: false,
    });
    expect(debuggerCalls.some((c) => c.tabId === 11 && c.method === 'Page.enable')).toBe(true);
  });

  it('前面的 owned tab 已关掉时跳过继续找', async () => {
    addTab({ id: 10, url: 'https://target.example/gone' });
    addTab({ id: 11, url: 'https://target.example/alive' });
    const { fireRemoved } = await import('../test-chrome');
    fireRemoved(10);
    const result = (await tool.execute(
      { url: 'https://target.example', _tabIds: [10, 11], _session: 's' },
      ctx,
    )) as { tabId: number };
    expect(result.tabId).toBe(11);
  });

  it('owned tab 的 url 解析失败（非法 url）不算命中，继续看下一个', async () => {
    addTab({ id: 10, url: 'not a url' });
    addTab({ id: 11, url: 'https://target.example/page' });
    const result = (await tool.execute(
      { url: 'https://target.example', _tabIds: [10, 11], _session: 's' },
      ctx,
    )) as { tabId: number };
    expect(result.tabId).toBe(11);
  });

  it('session 里没有匹配时报错并建议 navigate 或 active:true', async () => {
    addTab({ id: 10, url: 'https://owned.example' });
    await expect(
      tool.execute({ url: 'https://missing.example', _tabIds: [10], _session: 's' }, ctx),
    ).rejects.toThrow(
      /no tab matching https:\/\/missing.example in this session — use navigate to open it, or pass active:true/,
    );
  });

  it('没有 owned tab 时同样报 session 无匹配', async () => {
    await expect(
      tool.execute({ url: 'https://any.example', _tabIds: [], _session: 's' }, ctx),
    ).rejects.toThrow(/no tab matching/);
  });
});
