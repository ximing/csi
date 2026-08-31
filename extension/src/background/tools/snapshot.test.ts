/**
 * snapshot 工具层集成测试（协议 §4.3）：
 * interactive 上下文化分组、match 过滤（先过滤后 max_chars）、
 * 零命中 matches:0 成功、max_chars 截断。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';

installChrome();

const { SnapshotTool } = await import('./snapshot');
const ctx = { tabId: 10, documentEpoch: 1 };

interface SnapshotResult {
  mode: string;
  chars: number;
  source_chars: number;
  returned_chars: number;
  matches?: number;
  truncated: boolean;
  tree: string;
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

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example', title: 'A' });
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
