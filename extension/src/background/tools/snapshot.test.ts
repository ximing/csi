/**
 * snapshot 工具层集成测试（协议 §4.1 / §4.3）：
 * interactive 上下文化分组、match 过滤（先过滤后 max_chars）、
 * 零命中 matches:0 成功、max_chars 截断、full 模式 JSON 树（generic 折叠、
 * filterFullTree、超预算转 artifact）、selector 子树与 iframe/frame 进帧入口、
 * 帧标题、iframe 行的 src/isolated 渲染（帧 owner 表）、参数校验。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { SnapshotTool } = await import('./snapshot');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

interface SnapshotResult {
  url: string;
  title: string;
  mode: string;
  chars: number;
  source_chars: number;
  returned_chars: number;
  matches?: number;
  truncated: boolean;
  tree: string;
}

interface FullResult {
  url: string;
  title: string;
  mode: string;
  chars: number;
  source_chars: number;
  returned_chars: number;
  matches?: number;
  truncated: boolean;
  tree: unknown[];
  artifact?: { suggestedName: string; data: string };
  preview?: string;
}

function stubNodes(nodes: unknown[]): () => void {
  const original = chrome.debugger.sendCommand;
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
    (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root', url: 'https://a.example' } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      return original(debuggee, method, params as object);
    }) as typeof chrome.debugger.sendCommand;
  return () => {
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
  };
}

type CdpHandler = (params: Record<string, any>) => unknown;

/** 局部覆写 chrome.debugger.sendCommand：按 method 分发，未命中的走原 fake。 */
function stubCdp(handlers: Record<string, CdpHandler>): () => void {
  const original = chrome.debugger.sendCommand;
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
    (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
      const h = handlers[method];
      if (h) return h((params ?? {}) as Record<string, any>);
      return original(debuggee, method, params as object);
    }) as typeof chrome.debugger.sendCommand;
  return () => {
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
  };
}

/** 顶层页面的缺省 AX/帧响应（无子帧）。 */
function topHandlers(nodes: unknown[], extra: Record<string, CdpHandler> = {}): Record<string, CdpHandler> {
  return {
    'Accessibility.getFullAXTree': () => ({ nodes }),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'root', url: 'https://a.example' } } }),
    'Runtime.evaluate': (p) => {
      const expr = String(p.expression ?? '');
      if (expr.includes('querySelectorAll')) return { result: { value: [] } };
      if (expr.startsWith('document.querySelector')) return { result: { objectId: 'o1' } };
      return { result: { value: null } };
    },
    ...extra,
  };
}

interface FakeFrame {
  id: string;
  url: string;
  /** DOM.getFrameOwner 返回的帧 owner backendDOMNodeId；缺省 → 模拟帧已卸载（抛错跳过）。 */
  ownerNodeId?: number;
  /** true → 无 securityOrigin，listAllFrames 判为跨域隔离帧。 */
  isolated?: boolean;
}

/**
 * 带子帧的 CDP 响应：Page.getFrameTree / domIframeRows / DOM.getFrameOwner /
 * document.title / document.querySelector，AX 树按 frameId 区分顶层与子帧。
 */
function frameHandlers(
  frames: FakeFrame[],
  opts: {
    topNodes?: unknown[];
    frameNodes?: unknown[];
    describeNode?: () => unknown;
    title?: () => unknown;
    axThrowsForFrame?: boolean;
  } = {},
): Record<string, CdpHandler> {
  const rows = frames.map((f) => ({ src: f.url, name: f.id, sandbox: null, sameDoc: true }));
  return {
    'Page.getFrameTree': () => ({
      frameTree: {
        frame: { id: 'root', url: 'https://a.example' },
        childFrames: frames.map((f) => ({
          frame: {
            id: f.id,
            parentId: 'root',
            url: f.url,
            // 同源帧的 securityOrigin 用 origin（不是完整 URL），才会被判为非隔离
            ...(f.isolated ? {} : { securityOrigin: new URL(f.url).origin }),
          },
        })),
      },
    }),
    'Accessibility.getFullAXTree': (p) => {
      if (p.frameId) {
        if (opts.axThrowsForFrame) throw new Error('cdp boom in frame');
        return { nodes: opts.frameNodes ?? [] };
      }
      return { nodes: opts.topNodes ?? [] };
    },
    'Runtime.evaluate': (p) => {
      const expr = String(p.expression ?? '');
      if (expr.includes('querySelectorAll')) {
        // 追加一个不在帧树里的 src → 生成 isolated: 占位帧（owner 循环应跳过）
        return { result: { value: [...rows, { src: 'https://ghost.example/g', name: 'ghost', sandbox: null, sameDoc: false }] } };
      }
      if (expr.includes('document.title')) {
        if (opts.title) return opts.title();
        return { result: { value: 'Embed Title' } };
      }
      if (expr.startsWith('document.querySelector')) return { result: { objectId: 'o1' } };
      return { result: { value: null } };
    },
    'DOM.getFrameOwner': (p) => {
      const f = frames.find((x) => x.id === p.frameId);
      if (!f || f.ownerNodeId == null) throw new Error('frame owner gone');
      return { backendNodeId: f.ownerNodeId };
    },
    ...(opts.describeNode ? { 'DOM.describeNode': opts.describeNode } : {}),
  };
}

/** 预置 child 帧的 default execution context，避免 contextIdForFrame 走 1s 等待。 */
function primeFrameContext(frameId: string, contextId: number): void {
  fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
    context: { id: contextId, auxData: { frameId, isDefault: true } },
  });
}

function fixtureNodes(): unknown[] {
  return [
    { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['d1', 'd2', 'b3'] },
    {
      nodeId: 'd1',
      role: { value: 'dialog' },
      name: { value: 'Delete project' },
      childIds: ['b1', 'b2'],
    },
    { nodeId: 'b1', role: { value: 'button' }, name: { value: 'Cancel' }, backendDOMNodeId: 101 },
    { nodeId: 'b2', role: { value: 'button' }, name: { value: 'Delete' }, backendDOMNodeId: 102 },
    {
      nodeId: 'd2',
      role: { value: 'row' },
      name: { value: 'Alice' },
      childIds: ['b4'],
    },
    { nodeId: 'b4', role: { value: 'button' }, name: { value: 'Delete' }, backendDOMNodeId: 104 },
    { nodeId: 'b3', role: { value: 'button' }, name: { value: 'Lone' }, backendDOMNodeId: 103 },
  ];
}

async function snap(args: Record<string, unknown>): Promise<SnapshotResult> {
  return (await new SnapshotTool().execute(args, ctx)) as SnapshotResult;
}

let restore: () => void;

afterEach(() => {
  restore?.();
});

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example', title: 'A' });
  refs.deleteTargetState(10); // 进帧 snapshot 不 reset refs（追加编号），测试间要清
  restore?.();
  restore = stubNodes(fixtureNodes());
});

describe('interactive 上下文化（协议 §4.3）', () => {
  it('共享祖先分组，孤立节点单行', async () => {
    const res = await snap({ mode: 'interactive' });
    expect(res.tree).toBe(
      [
        '- dialog "Delete project"',
        '  - button "Cancel" [ref=@e1]',
        '  - button "Delete" [ref=@e2]',
        '- row "Alice"',
        '  - button "Delete" [ref=@e3]',
        '- button "Lone" [ref=@e4]',
        '',
      ].join('\n'),
    );
    expect(res.source_chars).toBe(res.chars);
    expect(res.returned_chars).toBe(res.chars);
    expect(res.matches).toBeUndefined();
  });
});

describe('match（协议 §4.3）', () => {
  it('exact 命中并带最小祖先上下文', async () => {
    const res = await snap({ mode: 'interactive', match: { name: 'Delete', exact: true } });
    expect(res.matches).toBe(2);
    // 两个 Delete 分别在 dialog 与 row 上下文里，不重复整条路径。
    expect(res.tree).toContain('- dialog "Delete project"');
    expect(res.tree).toContain('- row "Alice"');
    expect(res.tree).not.toContain('Cancel');
    expect(res.tree).not.toContain('Lone');
  });

  it('零命中是 matches:0 的成功结果', async () => {
    const res = await snap({ mode: 'compact', match: { name: 'Nope' } });
    expect(res.matches).toBe(0);
    expect(res.tree).toBe('');
    expect(res.truncated).toBe(false);
  });

  it('match.name 必填', async () => {
    await expect(snap({ match: { role: 'button' } })).rejects.toThrow(/match\.name is required/);
  });

  it('先 match 再应用 max_chars（协议 §4.3）', async () => {
    // 整表远超 1000 字符，但过滤后只剩一行 → 不截断。
    const res = await snap({ mode: 'interactive', match: { name: 'Lone' }, max_chars: 1000 });
    expect(res.matches).toBe(1);
    expect(res.tree).toBe('- button "Lone" [ref=@e4]\n');
    expect(res.truncated).toBe(false);
  });

  it('role 过滤（子串需显式 exact:false）', async () => {
    const sub = await snap({ mode: 'compact', match: { role: 'button', name: 'el', exact: false } });
    // “Cancel”“Delete”×2 都含 “el”。
    expect(sub.matches).toBe(3);
  });

  it('compact 超长 name 的 exact match 按完整可访问名称，不按 YAML 裁剪后的 119+省略号', async () => {
    restore();
    const longName = 'N'.repeat(200);
    restore = stubNodes([
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['b1'] },
      { nodeId: 'b1', role: { value: 'button' }, name: { value: longName }, backendDOMNodeId: 1 },
    ]);
    const res = await snap({ match: { name: longName, exact: true } });
    expect(res.matches).toBe(1);
    expect(res.tree).toContain(`${'N'.repeat(119)}…`);
  });
});

describe('max_chars 截断（协议 §4.3）', () => {
  it('compact 超预算截断：source_chars 记裁剪前规模', async () => {
    restore();
    const many = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: Array.from({ length: 40 }, (_, i) => `b${i}`) },
      ...Array.from({ length: 40 }, (_, i) => ({
        nodeId: `b${i}`,
        role: { value: 'button' },
        name: { value: `A quite long button accessible name number ${i}` },
        backendDOMNodeId: 500 + i,
      })),
    ];
    restore = stubNodes(many);
    const res = await snap({ mode: 'compact', max_chars: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.source_chars).toBeGreaterThan(1000);
    expect(res.returned_chars).toBe(res.chars);
    expect(res.chars).toBeLessThanOrEqual(res.source_chars);
  });
});

describe('参数校验（协议 §4.3）', () => {
  it('mode 非法值 → 报错', async () => {
    await expect(snap({ mode: 'yaml' })).rejects.toThrow(
      /mode must be compact, interactive, or full/,
    );
  });

  it('max_chars 越界/非整数 → 报错', async () => {
    for (const bad of [999, 81_000, 'x', 1.5]) {
      await expect(snap({ max_chars: bad })).rejects.toThrow(
        /max_chars must be an integer between 1000 and 80000/,
      );
    }
  });

  it('match 非对象（字符串/数组）→ 报错', async () => {
    await expect(snap({ match: 'button' })).rejects.toThrow(/match must be an object/);
    await expect(snap({ match: [{ name: 'x' }] })).rejects.toThrow(/match must be an object/);
  });

  it('match.name 缺失/非字符串/空串 → 报错', async () => {
    await expect(snap({ match: { role: 'button' } })).rejects.toThrow(/match\.name is required/);
    await expect(snap({ match: { name: 123 } })).rejects.toThrow(/match\.name is required/);
    await expect(snap({ match: { name: '' } })).rejects.toThrow(/match\.name is required/);
  });

  it('match.role 非字符串 → 报错', async () => {
    await expect(snap({ match: { name: 'x', role: 5 } })).rejects.toThrow(
      /match\.role must be a string/,
    );
  });

  it('match.exact 非布尔 → 报错', async () => {
    await expect(snap({ match: { name: 'x', exact: 'yes' } })).rejects.toThrow(
      /match\.exact must be a boolean/,
    );
  });

  it('selector 空串等同未提供（拍整页）', async () => {
    const res = await snap({ selector: '' });
    expect(res.tree).toContain('- button "Lone"');
  });

  it('frame 非字符串 → 报错', async () => {
    await expect(snap({ frame: 5 })).rejects.toThrow(/frame must be a string/);
  });
});

describe('full 模式（协议 §4.3 JSON 树）', () => {
  it('generic/none 折叠、value/description、ref 分配、无 backendDOMNodeId 不给 ref', async () => {
    restore();
    const nodes = [
      {
        nodeId: 'root',
        role: { value: 'RootWebArea' },
        name: { value: 'P' },
        childIds: ['g1', 'g2', 'g3', 'gn', 'ghost', 'tb', 'ifr', 'b5', 'h42', 'hn', 'd1', 'd2', 'bn', 'ifn'],
      },
      { nodeId: 'g1', role: { value: 'generic' }, childIds: ['h1'] }, // 单子 → 上提
      { nodeId: 'g2', role: { value: 'generic' }, childIds: ['h2', 'h3', 'ghost'] }, // 多子 → 数组上提；ghost 跳过
      { nodeId: 'g3', role: { value: 'generic' } }, // 无 childIds → 丢弃
      { nodeId: 'gn', role: { value: 'none' }, childIds: ['h4'] }, // none 同样折叠
      { nodeId: 'h1', role: { value: 'heading' }, name: { value: 'T' } },
      { nodeId: 'h2', role: { value: 'heading' }, name: { value: 'U' } },
      { nodeId: 'h3', role: { value: 'heading' }, name: { value: 'V' } },
      { nodeId: 'h4', role: { value: 'heading' }, name: { value: 'W' } },
      {
        nodeId: 'tb',
        role: { value: 'textbox' },
        name: { value: 'Email' },
        value: { value: 'a@b' },
        description: { value: 'your email' },
        backendDOMNodeId: 7,
      },
      { nodeId: 'ifr', role: { value: 'iframe' }, name: { value: 'Ad' }, backendDOMNodeId: 8 },
      { nodeId: 'b5', role: { value: 'button' }, name: { value: 'NoRef' } }, // 无 backendDOMNodeId
      { nodeId: 'h42', role: { value: 'heading' }, name: { value: 42 } }, // 数字 name
      { nodeId: 'hn', role: { value: 'heading' } }, // 无 name
      { nodeId: 'bn', role: { value: 'button' }, backendDOMNodeId: 9 }, // 有 ref 无 name
      { nodeId: 'ifn', role: { value: 'iframe' }, backendDOMNodeId: 10 }, // 帧角色有 ref 无 name
      // d1 的 childIds 里带一个不存在的 'ghost'（buildTree 跳过）
      { nodeId: 'd1', role: { value: 'dialog' }, name: { value: 'D' }, childIds: ['g4', 'h5', 'ghost'] },
      { nodeId: 'g4', role: { value: 'generic' }, childIds: ['h6', 'h7'] },
      { nodeId: 'h5', role: { value: 'heading' }, name: { value: 'H5' } },
      { nodeId: 'h6', role: { value: 'heading' }, name: { value: 'H6' } },
      { nodeId: 'h7', role: { value: 'heading' }, name: { value: 'H7' } },
      // d2 → g5 → g6 全是无效 generic 链：children 全 null → 整链丢弃、无 children 键
      { nodeId: 'd2', role: { value: 'dialog' }, name: { value: 'D2' }, childIds: ['g5'] },
      { nodeId: 'g5', role: { value: 'generic' }, childIds: ['g6'] },
      { nodeId: 'g6', role: { value: 'generic' } },
    ];
    restore = stubCdp(topHandlers(nodes));
    const res = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as unknown as FullResult;
    expect(res.mode).toBe('full');
    expect(res.truncated).toBe(false);
    expect(res.url).toBe('https://a.example');
    expect(res.title).toBe('A');
    expect(res.matches).toBeUndefined();
    expect(res.chars).toBe(JSON.stringify(res.tree).length);
    expect(res.tree).toEqual([
      { role: 'heading', name: 'T' },
      { role: 'heading', name: 'U' },
      { role: 'heading', name: 'V' },
      { role: 'heading', name: 'W' },
      { role: 'textbox', name: 'Email', value: 'a@b', description: 'your email', ref: '@e1' },
      { role: 'iframe', name: 'Ad', ref: '@e2' },
      { role: 'button', name: 'NoRef' },
      { role: 'heading', name: 42 },
      { role: 'heading' },
      { role: 'dialog', name: 'D', children: [
        { role: 'heading', name: 'H6' },
        { role: 'heading', name: 'H7' },
        { role: 'heading', name: 'H5' },
      ] },
      { role: 'dialog', name: 'D2' }, // 无效子链全部丢弃，无 children 键
      { role: 'button', ref: '@e3' },
      { role: 'iframe', ref: '@e4' },
    ]);
  });

  it('match 过滤 full 树：命中保留子树、祖先变上下文行、无名祖先无 name 键', async () => {
    restore();
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['d1', 'row1', 'reg', 'h42', 'hn', 'd2'] },
      { nodeId: 'd1', role: { value: 'dialog' }, name: { value: 'Delete project' }, childIds: ['b1', 'b2'] },
      { nodeId: 'b1', role: { value: 'button' }, name: { value: 'Cancel' }, backendDOMNodeId: 101 },
      { nodeId: 'b2', role: { value: 'button' }, name: { value: 'Delete' }, backendDOMNodeId: 102 },
      { nodeId: 'row1', role: { value: 'row' }, name: { value: 'Alice' }, childIds: ['b3'] },
      { nodeId: 'b3', role: { value: 'button' }, name: { value: 'Delete' }, backendDOMNodeId: 103 },
      { nodeId: 'reg', role: { value: 'region' }, childIds: ['b4'] }, // 无名 region 仍是上下文行
      { nodeId: 'b4', role: { value: 'button' }, name: { value: 'Delete' }, backendDOMNodeId: 104 },
      { nodeId: 'h42', role: { value: 'heading' }, name: { value: 42 } },
      { nodeId: 'hn', role: { value: 'heading' } },
      // 有子树但零命中的分支整体丢弃（kept 为空 → null）
      { nodeId: 'd2', role: { value: 'dialog' }, name: { value: 'Keep' }, childIds: ['grp'] },
      { nodeId: 'grp', role: { value: 'group' }, childIds: ['h9'] },
      { nodeId: 'h9', role: { value: 'heading' }, name: { value: 'Nope' } },
    ];
    restore = stubCdp(topHandlers(nodes));
    const res = (await new SnapshotTool().execute(
      { mode: 'full', match: { name: 'Delete', exact: true } },
      ctx,
    )) as unknown as FullResult;
    expect(res.matches).toBe(3);
    expect(res.tree).toEqual([
      { role: 'dialog', name: 'Delete project', children: [{ role: 'button', name: 'Delete', ref: '@e2' }] },
      { role: 'row', name: 'Alice', children: [{ role: 'button', name: 'Delete', ref: '@e3' }] },
      { role: 'region', children: [{ role: 'button', name: 'Delete', ref: '@e4' }] },
    ]);
  });

  it('full + match.role 大小写不敏感（AX 原角色 Button / StaticText）', async () => {
    restore();
    restore = stubCdp(
      topHandlers([
        { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['b1', 't1'] },
        { nodeId: 'b1', role: { value: 'Button' }, name: { value: 'Go' }, backendDOMNodeId: 101 },
        { nodeId: 't1', role: { value: 'StaticText' }, name: { value: 'Hi' } },
      ]),
    );
    const byButton = (await new SnapshotTool().execute(
      { mode: 'full', match: { role: 'button', name: 'Go' } },
      ctx,
    )) as unknown as FullResult;
    expect(byButton.matches).toBe(1);
    expect(byButton.tree).toEqual([{ role: 'Button', name: 'Go' }]);

    refs.deleteTargetState(10);
    const byText = (await new SnapshotTool().execute(
      { mode: 'full', match: { role: 'text', name: 'Hi' } },
      ctx,
    )) as unknown as FullResult;
    expect(byText.matches).toBe(1);
    expect(byText.tree).toEqual([{ role: 'StaticText', name: 'Hi' }]);
  });

  it('full + selector：命名根节点 → 单元素数组', async () => {
    restore();
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: [] },
      { nodeId: 'sub', role: { value: 'dialog' }, name: { value: 'Sub' }, backendDOMNodeId: 5, childIds: ['b1'] },
      { nodeId: 'b1', role: { value: 'button' }, name: { value: 'OK' }, backendDOMNodeId: 6 },
    ];
    restore = stubCdp(
      topHandlers(nodes, { 'DOM.describeNode': () => ({ node: { nodeName: 'div', backendNodeId: 5 } }) }),
    );
    const res = (await new SnapshotTool().execute({ mode: 'full', selector: '#sub' }, ctx)) as unknown as FullResult;
    expect(res.tree).toEqual([
      { role: 'dialog', name: 'Sub', children: [{ role: 'button', name: 'OK', ref: '@e1' }] },
    ]);
  });

  it('tab 无 url/title → 空串兜底', async () => {
    restore();
    resetChromeState();
    addTab({ id: 10 });
    restore = stubCdp(topHandlers([{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' } }]));
    const res = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as unknown as FullResult;
    expect(res.url).toBe('');
    expect(res.title).toBe('');
  });

  it('selector 子树（generic 根）→ 数组上提；generic 根无子 → 空树', async () => {
    restore();
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: [] },
      { nodeId: 'sub', role: { value: 'generic' }, backendDOMNodeId: 5, childIds: ['h1', 'h2'] },
      { nodeId: 'bare', role: { value: 'generic' }, backendDOMNodeId: 6 },
      { nodeId: 'h1', role: { value: 'heading' }, name: { value: 'A' } },
      { nodeId: 'h2', role: { value: 'heading' }, name: { value: 'B' } },
    ];
    const handlers = topHandlers(nodes, {
      'DOM.describeNode': () => ({ node: { nodeName: 'div', backendNodeId: 5 } }),
    });
    restore = stubCdp(handlers);
    const res = (await new SnapshotTool().execute({ mode: 'full', selector: '#sub' }, ctx)) as unknown as FullResult;
    expect(res.tree).toEqual([{ role: 'heading', name: 'A' }, { role: 'heading', name: 'B' }]);

    // 子树根是无效 generic（无子）→ formatNode null → 空树
    restore();
    restore = stubCdp(
      topHandlers(nodes, { 'DOM.describeNode': () => ({ node: { nodeName: 'div', backendNodeId: 6 } }) }),
    );
    const bare = (await new SnapshotTool().execute({ mode: 'full', selector: '#sub' }, ctx)) as unknown as FullResult;
    expect(bare.tree).toEqual([]);
  });

  it('AX 树为空 / 根无 childIds → 空树', async () => {
    restore();
    restore = stubCdp(topHandlers([]));
    const empty = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as unknown as FullResult;
    expect(empty.tree).toEqual([]);

    restore();
    restore = stubCdp(topHandlers([{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' } }]));
    const noChildren = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as unknown as FullResult;
    expect(noChildren.tree).toEqual([]);
  });

  it('full 树超 80000 字符 → 转 artifact 信封（协议 §4.3/§3.5），不截断 JSON', async () => {
    restore();
    const many = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: Array.from({ length: 600 }, (_, i) => `b${i}`) },
      ...Array.from({ length: 600 }, (_, i) => ({
        nodeId: `b${i}`,
        role: { value: 'button' },
        name: { value: `Button ${i} ${'n'.repeat(150)}` },
        backendDOMNodeId: 1000 + i,
      })),
    ];
    restore = stubCdp(topHandlers(many));
    const res = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as unknown as FullResult;
    expect(res.truncated).toBe(true);
    expect(res.matches).toBeUndefined();
    expect(res.source_chars).toBeGreaterThan(80_000);
    expect(res.artifact?.suggestedName).toBe('csi-snapshot-full.json');
    expect(res.artifact?.data.length).toBe(res.source_chars);
    expect(res.preview).toContain('preview truncated');
    expect(res.returned_chars).toBe(res.preview?.length);
    expect(res.chars).toBe(res.preview?.length);

    // match 在超预算树上同样生效：子串命中全部 600 个节点，过滤后仍超预算
    // → matches 随 artifact 信封一起返回。
    const withMatch = (await new SnapshotTool().execute(
      { mode: 'full', match: { name: 'Button', exact: false } },
      ctx,
    )) as unknown as FullResult;
    expect(withMatch.truncated).toBe(true);
    expect(withMatch.matches).toBe(600);
  });
});

describe('selector 子树（compact，协议 §4.1）', () => {
  it('selector 指向普通元素：以该元素为根拍子树', async () => {
    restore();
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['b0'] },
      { nodeId: 'b0', role: { value: 'button' }, name: { value: 'Outside' }, backendDOMNodeId: 1 },
      { nodeId: 'sub', role: { value: 'dialog' }, name: { value: 'Sub' }, backendDOMNodeId: 5, childIds: ['b1'] },
      { nodeId: 'b1', role: { value: 'button' }, name: { value: 'OK' }, backendDOMNodeId: 6 },
    ];
    restore = stubCdp(
      topHandlers(nodes, { 'DOM.describeNode': () => ({ node: { nodeName: 'div', backendNodeId: 5 } }) }),
    );
    const res = await snap({ selector: '#sub' });
    expect(res.tree).toBe(['- dialog "Sub"', '  - button "OK" [ref=@e1]', ''].join('\n'));
  });

  it('backendDOMNodeId 不在 AX 树 → element not found', async () => {
    restore();
    restore = stubCdp(
      topHandlers([], { 'DOM.describeNode': () => ({ node: { nodeName: 'div', backendNodeId: 999 } }) }),
    );
    await expect(snap({ selector: '#sub' })).rejects.toThrow(/snapshot: element not found: #sub/);
  });

  it('describeNode 无 node → element not found', async () => {
    restore();
    restore = stubCdp(topHandlers([], { 'DOM.describeNode': () => ({}) }));
    await expect(snap({ selector: '#sub' })).rejects.toThrow(/snapshot: element not found: #sub/);
  });

  it('AX 拉取失败（无帧上下文）→ 原样上抛', async () => {
    restore();
    restore = stubCdp(
      topHandlers([], {
        'Accessibility.getFullAXTree': () => {
          throw new Error('cdp boom');
        },
      }),
    );
    await expect(snap({})).rejects.toThrow(/cdp boom/);
  });
});

describe('selector 指向 iframe / frame（协议 §4.1 进帧入口）', () => {
  const frameNodes = [
    { nodeId: 'fr', role: { value: 'RootWebArea' }, name: { value: 'Embed' }, childIds: ['b1'] },
    { nodeId: 'b1', role: { value: 'button' }, name: { value: 'In Frame' }, backendDOMNodeId: 77 },
  ];

  it('拍子帧：AX 带 frameId，url/title 取该帧，refs 追加不 reset', async () => {
    restore();
    primeFrameContext('child', 7);
    let axParams: unknown;
    restore = stubCdp(
      frameHandlers([{ id: 'child', url: 'https://a.example/embed', ownerNodeId: 55 }], {
        frameNodes,
        describeNode: () => ({ node: { nodeName: 'IFRAME', frameId: 'child' } }),
      }),
    );
    const orig = chrome.debugger.sendCommand;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
      (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
        if (method === 'Accessibility.getFullAXTree') axParams = params;
        return orig(debuggee, method, params as object);
      }) as typeof chrome.debugger.sendCommand;
    const res = await snap({ selector: '#f' });
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = orig;
    expect(axParams).toEqual({ frameId: 'child' });
    expect(res.url).toBe('https://a.example/embed');
    expect(res.title).toBe('Embed Title');
    expect(res.tree).toBe('- button "In Frame" [ref=@e1]\n');

    // 进帧 snapshot 同样做 match 过滤（协议 §4.1/§4.3）；refs 不 reset（追加编号）。
    const res2 = await snap({ selector: '#f', match: { name: 'In Frame' } });
    expect(res2.matches).toBe(1);
    expect(res2.tree).toBe('- button "In Frame" [ref=@e2]\n');
  });

  it('selector 与 frame 参数不是同一帧 → 报错', async () => {
    restore();
    restore = stubCdp(
      frameHandlers(
        [
          { id: 'childA', url: 'https://a.example/a' },
          { id: 'childB', url: 'https://a.example/b' },
        ],
        { describeNode: () => ({ node: { nodeName: 'IFRAME', frameId: 'childA' } }) },
      ),
    );
    await expect(snap({ selector: '#f', frame: 'childB' })).rejects.toThrow(
      /selector and frame do not refer to the same frame/,
    );
  });

  it('selector 指向 FRAME 且该帧跨域隔离 → cross-origin 报错', async () => {
    restore();
    restore = stubCdp(
      frameHandlers([{ id: 'childIso', url: 'https://other.example/x', isolated: true }], {
        describeNode: () => ({ node: { nodeName: 'FRAME', frameId: 'childIso' } }),
      }),
    );
    await expect(snap({ selector: '#f' })).rejects.toThrow(/cross-origin frame/);
  });

  it('iframe 节点无 frameId（帧已卸载）→ frame gone', async () => {
    restore();
    restore = stubCdp(
      frameHandlers([], { describeNode: () => ({ node: { nodeName: 'IFRAME' } }) }),
    );
    await expect(snap({ selector: '#f' })).rejects.toThrow(/frame is gone/);
  });

  it('子帧 AX 拉取失败 → frame gone（不吞成原始 CDP 错）', async () => {
    restore();
    restore = stubCdp(
      frameHandlers([{ id: 'child', url: 'https://a.example/embed' }], {
        frameNodes: [],
        axThrowsForFrame: true,
        describeNode: () => ({ node: { nodeName: 'IFRAME', frameId: 'child' } }),
      }),
    );
    await expect(snap({ selector: '#f' })).rejects.toThrow(/frame is gone/);
  });
});

describe('frame 参数直接进帧（协议 §4.1 入口 2）', () => {
  const frameNodes = [
    { nodeId: 'fr', role: { value: 'RootWebArea' }, name: { value: 'Embed' }, childIds: ['b1'] },
    { nodeId: 'b1', role: { value: 'button' }, name: { value: 'In Frame' }, backendDOMNodeId: 77 },
  ];

  it('frame= 进帧：AX 带 frameId，url/title 取该帧', async () => {
    restore();
    primeFrameContext('child', 7);
    let axParams: unknown;
    restore = stubCdp(frameHandlers([{ id: 'child', url: 'https://a.example/embed' }], { frameNodes }));
    const orig = chrome.debugger.sendCommand;
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
      (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
        if (method === 'Accessibility.getFullAXTree') axParams = params;
        return orig(debuggee, method, params as object);
      }) as typeof chrome.debugger.sendCommand;
    const res = await snap({ frame: 'child' });
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = orig;
    expect(axParams).toEqual({ frameId: 'child' });
    expect(res.url).toBe('https://a.example/embed');
    expect(res.title).toBe('Embed Title');
    expect(res.tree).toBe('- button "In Frame" [ref=@e1]\n');
  });

  it('帧标题取失败 → title 空串（不报错）', async () => {
    restore();
    primeFrameContext('child', 7);
    restore = stubCdp(
      frameHandlers([{ id: 'child', url: 'https://a.example/embed' }], {
        frameNodes,
        title: () => {
          throw new Error('title eval boom');
        },
      }),
    );
    const res = await snap({ frame: 'child' });
    expect(res.title).toBe('');
    expect(res.tree).toBe('- button "In Frame" [ref=@e1]\n');
  });

  it('帧标题 evaluate 无值 → title 空串', async () => {
    restore();
    primeFrameContext('child', 7);
    restore = stubCdp(
      frameHandlers([{ id: 'child', url: 'https://a.example/embed' }], {
        frameNodes,
        title: () => ({ result: {} }),
      }),
    );
    const res = await snap({ frame: 'child' });
    expect(res.title).toBe('');
  });

  it('frame= 指向跨域隔离帧 → cross-origin 报错', async () => {
    restore();
    restore = stubCdp(frameHandlers([{ id: 'childIso', url: 'https://other.example/x', isolated: true }]));
    await expect(snap({ frame: 'childIso' })).rejects.toThrow(/cross-origin frame/);
  });

  it('frame= 匹配不到任何帧 → 报错', async () => {
    restore();
    restore = stubCdp(frameHandlers([{ id: 'child', url: 'https://a.example/embed' }]));
    await expect(snap({ frame: 'no-such-frame' })).rejects.toThrow(/no frame matching/);
  });

  it('子帧 AX 拉取失败 → frame gone', async () => {
    restore();
    restore = stubCdp(
      frameHandlers([{ id: 'child', url: 'https://a.example/embed' }], { axThrowsForFrame: true }),
    );
    await expect(snap({ frame: 'child' })).rejects.toThrow(/frame is gone/);
  });
});

describe('iframe 行的 src/isolated 渲染（协议 §4.1 帧 owner 表）', () => {
  it('src/isolated 按帧 owner backendDOMNodeId 对号；owner 查不到的帧跳过；子树不下钻', async () => {
    restore();
    const nodes = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['f1', 'f2', 'f3'] },
      { nodeId: 'f1', role: { value: 'iframe' }, name: { value: 'Ad' }, backendDOMNodeId: 55, childIds: ['x'] },
      { nodeId: 'f2', role: { value: 'iframe' }, name: { value: 'X' }, backendDOMNodeId: 56 },
      { nodeId: 'f3', role: { value: 'iframe' }, name: { value: 'NoOwner' }, backendDOMNodeId: 57 },
      { nodeId: 'x', role: { value: 'button' }, name: { value: 'Inside' }, backendDOMNodeId: 99 },
    ];
    restore = stubCdp(
      frameHandlers(
        [
          { id: 'childA', url: 'https://a.example/embed', ownerNodeId: 55 },
          { id: 'childB', url: 'https://other.example/x', ownerNodeId: 56, isolated: true },
          { id: 'childC', url: 'https://a.example/noowner' }, // getFrameOwner 抛错 → 跳过
        ],
        { topNodes: nodes },
      ),
    );
    const res = await snap({});
    expect(res.tree).toBe(
      [
        '- iframe "Ad" [src=https://a.example/embed] [ref=@e1]',
        '- iframe "X" [isolated] [src=https://other.example/x] [ref=@e2]',
        '- iframe "NoOwner" [ref=@e3]',
        '',
      ].join('\n'),
    );
  });
});
