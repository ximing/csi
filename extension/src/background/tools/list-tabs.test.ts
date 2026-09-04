/**
 * list_tabs 测试（协议 §4）：只列 owned 的 _tabIds、组标题解析（组没了省略、
 * 无组跳过）、tab 已关跳过，以及 borrowed 当前目标的 currentTarget 附加字段。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { ListTabsTool } = await import('./list-tabs');

const tool = new ListTabsTool();
const ctx = { tabId: 0, documentEpoch: 0 };

interface ListedTab {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  groupTitle?: string;
}

const originalTabGroupsGet = chrome.tabGroups.get;
let groupsById: Record<number, { title: string }> = {};

beforeEach(() => {
  resetChromeState();
  groupsById = {};
  chrome.tabGroups = {
    ...chrome.tabGroups,
    get: async (id: number) => {
      if (!(id in groupsById)) throw new Error(`no group ${id}`);
      return groupsById[id]!;
    },
  } as typeof chrome.tabGroups;
});

describe('list_tabs', () => {
  it('没有 owned tab 时返回空列表', async () => {
    const result = (await tool.execute({ _tabIds: [], _session: 's' }, ctx)) as {
      success: boolean;
      tabs: unknown[];
    };
    expect(result).toEqual({ success: true, tabs: [] });
  });

  it('列出 owned tab 的 url/title/active 与组标题', async () => {
    addTab({ id: 10, url: 'https://a.example/page', title: 'A', active: true, groupId: 3 });
    addTab({ id: 11, url: 'https://b.example', title: 'B', active: false, groupId: -1 });
    groupsById = { 3: { title: 'agent:s' } };
    const result = (await tool.execute({ _tabIds: [10, 11], _session: 's' }, ctx)) as {
      tabs: ListedTab[];
      currentTarget?: unknown;
    };
    expect(result.tabs).toEqual([
      { tabId: 10, url: 'https://a.example/page', title: 'A', active: true, groupTitle: 'agent:s' },
      { tabId: 11, url: 'https://b.example', title: 'B', active: false, groupTitle: undefined },
    ]);
    expect(result.currentTarget).toBeUndefined();
  });

  it('组已被删掉时省略 groupTitle，tab 仍列出', async () => {
    addTab({ id: 10, url: 'https://a.example', title: 'A', groupId: 9 }); // groupsById 里没有 9
    const result = (await tool.execute({ _tabIds: [10], _session: 's' }, ctx)) as { tabs: ListedTab[] };
    expect(result.tabs).toEqual([
      // addTab 未给 active → 原样透传 undefined（生产代码不补默认值）
      { tabId: 10, url: 'https://a.example', title: 'A', active: undefined, groupTitle: undefined },
    ]);
  });

  it('已关掉的 owned tab 跳过', async () => {
    addTab({ id: 10, url: 'https://a.example', title: 'A' });
    addTab({ id: 11, url: 'https://b.example', title: 'B' });
    const { fireRemoved } = await import('../test-chrome');
    fireRemoved(10);
    const result = (await tool.execute({ _tabIds: [10, 11], _session: 's' }, ctx)) as { tabs: ListedTab[] };
    expect(result.tabs.map((t) => t.tabId)).toEqual([11]);
  });

  it('url/title 缺失时回空串', async () => {
    addTab({ id: 12 }); // 无 url/title
    const result = (await tool.execute({ _tabIds: [12], _session: 's' }, ctx)) as { tabs: ListedTab[] };
    expect(result.tabs).toEqual([
      { tabId: 12, url: '', title: '', active: undefined, groupTitle: undefined },
    ]);
  });

  it('borrowed 当前目标附加 currentTarget 字段', async () => {
    addTab({ id: 10, url: 'https://owned.example', title: 'Owned' });
    addTab({ id: 99, url: 'https://user.example', title: 'User tab' });
    const result = (await tool.execute(
      { _tabId: 99, _tabIds: [10], _borrowed: true, _session: 's' },
      ctx,
    )) as { currentTarget?: { tabId: number; borrowed: boolean; url: string; title: string } };
    expect(result.currentTarget).toEqual({
      tabId: 99,
      borrowed: true,
      url: 'https://user.example',
      title: 'User tab',
    });
  });

  it('borrowed 当前目标已关掉时仍回报 id（url/title 为空）', async () => {
    addTab({ id: 10, url: 'https://owned.example', title: 'Owned' });
    addTab({ id: 98, url: 'https://gone.example', title: 'Gone' });
    const { fireRemoved } = await import('../test-chrome');
    fireRemoved(98);
    const result = (await tool.execute(
      { _tabId: 98, _tabIds: [10], _borrowed: true, _session: 's' },
      ctx,
    )) as { currentTarget?: { tabId: number; url: string; title: string } };
    expect(result.currentTarget).toEqual({ tabId: 98, borrowed: true, url: '', title: '' });
  });

  it('当前目标就是 owned tab 或 _tabId 为 0 时没有 currentTarget', async () => {
    addTab({ id: 10, url: 'https://owned.example', title: 'Owned' });
    const owned = (await tool.execute(
      { _tabId: 10, _tabIds: [10], _borrowed: false, _session: 's' },
      ctx,
    )) as { currentTarget?: unknown };
    expect(owned.currentTarget).toBeUndefined();

    const zero = (await tool.execute({ _tabId: 0, _tabIds: [10], _session: 's' }, ctx)) as {
      currentTarget?: unknown;
    };
    expect(zero.currentTarget).toBeUndefined();
  });
});
