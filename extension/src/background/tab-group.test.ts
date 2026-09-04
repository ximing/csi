/**
 * tab-group 测试（协议 §3.4）：agent:<session> 分组的建立/复用/标题记忆、
 * 固定色与轮换色、组被用户删掉后的失效，以及关 tab 前的整组解组保护
 * （混合组不解，避免把用户自己的 tab 剥出组）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from './test-chrome';

installChrome();

const tabGroup = await import('./tab-group');

interface GroupOptions {
  tabIds: number | number[];
  groupId?: number;
}

const groupCalls: GroupOptions[] = [];
const ungroupCalls: number[][] = [];
const groupUpdates: { groupId: number; opts: Record<string, unknown> }[] = [];
// onRemoved 用持久对象：tab-group 模块的"只注册一次"标志跨测试存活，
// 不能每个 beforeEach 换新数组，否则后续测试里监听器注册不到当前 fake 上。
const groupRemovedListeners: ((group: { id: number }) => void)[] = [];
const persistentOnRemoved = {
  addListener: (fn: (group: { id: number }) => void) => groupRemovedListeners.push(fn),
};
let groupsByTitle: { id: number; title: string }[] = [];
let groupTabs: Record<number, { id?: number }[]> = {};
let tabsQueryImpl: (q: Record<string, unknown>) => Promise<{ id?: number }[]>;
let tabGroupsQueryShouldThrow = false;
let tabGroupsGetImpl: (id: number) => Promise<{ title: string }>;
// 组 id 单调递增不重置：sessionGroupIds 是模块级状态，跨测试复用同一个 id
// 会让 onRemoved 监听器"删第一个匹配的 session"删错对象（真实 Chrome 里 id 唯一）。
let nextGroupId = 500;

const originalTabGroups = chrome.tabGroups;
const originalTabsQuery = chrome.tabs.query;

beforeEach(() => {
  resetChromeState();
  groupCalls.length = 0;
  ungroupCalls.length = 0;
  groupUpdates.length = 0;
  groupsByTitle = [];
  groupTabs = {};
  tabGroupsQueryShouldThrow = false;
  tabsQueryImpl = async (q) => groupTabs[q.groupId as number] ?? [];
  tabGroupsGetImpl = async (id: number) => {
    const hit = Object.values(groupsByTitle).find((g) => g.id === id);
    return { title: hit?.title ?? `group-${id}` };
  };

  chrome.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    get: (id: number) => tabGroupsGetImpl(id),
    query: async (q: { title?: string }) => {
      if (tabGroupsQueryShouldThrow) throw new Error('tabGroups.query failed');
      return groupsByTitle.filter((g) => g.title === q.title);
    },
    update: async (groupId: number, opts: Record<string, unknown>) => {
      groupUpdates.push({ groupId, opts });
      return { id: groupId, ...opts };
    },
    onRemoved: persistentOnRemoved,
  } as unknown as typeof chrome.tabGroups;
  chrome.tabs.query = ((q: Record<string, unknown>) => tabsQueryImpl(q)) as typeof chrome.tabs.query;
  (chrome.tabs as unknown as { group: unknown }).group = async (opts: GroupOptions) => {
    groupCalls.push(opts);
    const id = nextGroupId++;
    if (opts.groupId == null) return id;
    return opts.groupId;
  };
  (chrome.tabs as unknown as { ungroup: unknown }).ungroup = async (ids: number[]) => {
    ungroupCalls.push(ids);
  };
  // 首个用到监听器的测试之前完成注册（模块标志保证只注册一次）
  if (groupRemovedListeners.length === 0) tabGroup.ensureGroupRemovedListener();
});

afterEach(() => {
  chrome.tabGroups = originalTabGroups;
  chrome.tabs.query = originalTabsQuery;
});

function fireGroupRemoved(id: number): void {
  for (const fn of [...groupRemovedListeners]) fn({ id });
}

describe('ensureGroupRemovedListener', () => {
  it('重复调用只注册一次监听器', () => {
    tabGroup.ensureGroupRemovedListener();
    tabGroup.ensureGroupRemovedListener();
    expect(groupRemovedListeners).toHaveLength(1);
  });

  it('组被用户删掉后 session 的映射失效，下次重新建组', async () => {
    tabGroup.ensureGroupRemovedListener();
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'sess-rm');
    const firstId = groupUpdates[0]!.groupId;
    expect(groupUpdates).toHaveLength(1);

    fireGroupRemoved(firstId);

    addTab({ id: 2, url: 'https://b.example' });
    await tabGroup.addToSessionGroup(2, 'sess-rm');
    // 不再带 groupId 复用，而是重新建组并再 update 一次
    expect(groupCalls[1]!.groupId).toBeUndefined();
    expect(groupUpdates).toHaveLength(2);
  });

  it('别的组被删不影响本 session 的映射', async () => {
    tabGroup.ensureGroupRemovedListener();
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'sess-keep');
    fireGroupRemoved(99999);
    addTab({ id: 2, url: 'https://b.example' });
    await tabGroup.addToSessionGroup(2, 'sess-keep');
    expect(groupCalls[1]!.groupId).toBe(groupUpdates[0]!.groupId); // 仍复用
    expect(groupUpdates).toHaveLength(1);
  });
});

describe('addToSessionGroup', () => {
  it('新建组：默认标题 agent:<session>、展开、并记住 session->groupId', async () => {
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'sess-new');
    expect(groupCalls).toEqual([{ tabIds: 1 }]);
    expect(groupUpdates).toHaveLength(1);
    expect(groupUpdates[0]!.opts).toMatchObject({ title: 'agent:sess-new', collapsed: false });

    addTab({ id: 2, url: 'https://b.example' });
    await tabGroup.addToSessionGroup(2, 'sess-new');
    expect(groupCalls[1]).toEqual({ tabIds: 2, groupId: groupUpdates[0]!.groupId });
    expect(groupUpdates).toHaveLength(1); // 复用后不再 update
  });

  it('已有同名默认标题的组时直接复用，不再 update', async () => {
    groupsByTitle = [{ id: 77, title: 'agent:sess-existing' }];
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'sess-existing');
    expect(groupCalls).toEqual([{ tabIds: 1, groupId: 77 }]);
    expect(groupUpdates).toEqual([]);
    // 且记住了映射：第二次直接走 knownGroupId
    await tabGroup.addToSessionGroup(2, 'sess-existing');
    expect(groupCalls[1]).toEqual({ tabIds: 2, groupId: 77 });
  });

  it('显式 groupTitle 建组，且组被删后重建仍记住该标题', async () => {
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'sess-title', 'Custom Title');
    expect(groupUpdates[0]!.opts.title).toBe('Custom Title');
    const firstId = groupUpdates[0]!.groupId;

    fireGroupRemoved(firstId);

    addTab({ id: 2, url: 'https://b.example' });
    await tabGroup.addToSessionGroup(2, 'sess-title'); // 这次不给 title
    expect(groupUpdates).toHaveLength(2);
    expect(groupUpdates[1]!.opts.title).toBe('Custom Title'); // 记忆的标题
  });

  it('已知 session 用固定色', async () => {
    addTab({ id: 1, url: 'https://a.example' });
    await tabGroup.addToSessionGroup(1, 'twitter');
    addTab({ id: 2, url: 'https://b.example' });
    await tabGroup.addToSessionGroup(2, 'xhs');
    addTab({ id: 3, url: 'https://c.example' });
    await tabGroup.addToSessionGroup(3, 'worldquant');
    expect(groupUpdates.map((u) => (u.opts as { color: string }).color)).toEqual([
      'blue',
      'red',
      'purple',
    ]);
  });

  it('未知 session 走轮换色，7 次建组覆盖全部 6 色并回到起点', async () => {
    for (let i = 1; i <= 7; i++) {
      addTab({ id: i, url: `https://rot${i}.example` });
      await tabGroup.addToSessionGroup(i, `rot-sess-${i}`);
    }
    expect(groupUpdates).toHaveLength(7);
    const colors = groupUpdates.map((u) => (u.opts as { color: string }).color);
    const palette = ['green', 'yellow', 'cyan', 'orange', 'pink', 'grey'];
    for (const c of colors) expect(palette).toContain(c);
    expect(new Set(colors).size).toBe(6); // 6 色都轮到
    expect(colors[6]).toBe(colors[0]); // 第 7 次回到起点
  });

  it('分组是 best-effort：tabs.group 抛错也不 reject', async () => {
    (chrome.tabs as unknown as { group: unknown }).group = async () => {
      throw new Error('group failed');
    };
    addTab({ id: 1, url: 'https://a.example' });
    await expect(tabGroup.addToSessionGroup(1, 'sess-err')).resolves.toBeUndefined();
  });

  it('tabGroups.query 抛错也不 reject（best-effort）', async () => {
    tabGroupsQueryShouldThrow = true;
    addTab({ id: 1, url: 'https://a.example' });
    await expect(tabGroup.addToSessionGroup(1, 'sess-qerr')).resolves.toBeUndefined();
  });
});

describe('ungroupClosedTabs', () => {
  it('整组都归 session 时，把要关的 tab 移出组', async () => {
    addTab({ id: 1, groupId: 5 });
    addTab({ id: 2, groupId: 5 });
    groupTabs = { 5: [{ id: 1 }, { id: 2 }] };
    await tabGroup.ungroupClosedTabs([1], [1, 2]);
    expect(ungroupCalls).toEqual([[1]]);
  });

  it('整组都关时把全部组员解组', async () => {
    addTab({ id: 1, groupId: 5 });
    addTab({ id: 2, groupId: 5 });
    groupTabs = { 5: [{ id: 1 }, { id: 2 }] };
    await tabGroup.ungroupClosedTabs([1, 2], [1, 2]);
    expect(ungroupCalls).toEqual([[1, 2]]);
  });

  it('混合组（含非 session 的 tab）不解组', async () => {
    addTab({ id: 1, groupId: 6 });
    groupTabs = { 6: [{ id: 1 }, { id: 99 }] }; // 99 是用户的 tab
    await tabGroup.ungroupClosedTabs([1], [1]);
    expect(ungroupCalls).toEqual([]);
  });

  it('组员 id 缺失时视为非整组 session 所有，不解组', async () => {
    addTab({ id: 1, groupId: 7 });
    groupTabs = { 7: [{ id: 1 }, {}] }; // 有组员不带 id
    await tabGroup.ungroupClosedTabs([1], [1]);
    expect(ungroupCalls).toEqual([]);
  });

  it('要关的 tab 已不存在或不在任何组时跳过', async () => {
    addTab({ id: 1, groupId: -1 }); // 无组
    await tabGroup.ungroupClosedTabs([1, 42], [1]); // 42 已被关掉
    expect(ungroupCalls).toEqual([]);
  });

  it('tabs.query 抛错时吞掉，绝不阻塞关 tab', async () => {
    addTab({ id: 1, groupId: 5 });
    groupTabs = { 5: [{ id: 1 }] };
    tabsQueryImpl = async () => {
      throw new Error('query failed');
    };
    await expect(tabGroup.ungroupClosedTabs([1], [1])).resolves.toBeUndefined();
    expect(ungroupCalls).toEqual([]);
  });
});
