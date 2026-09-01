/**
 * artifact 信封与预算测试（协议 §3.5 / §4.3 / §4.4）：
 * snapshot full >80000、evaluate/cdp 超 max_chars 时转 artifact；
 * preview 是明示的预览文本，不伪装成合法 JSON。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, installChrome, resetChromeState } from '../test-chrome';
import type { ArtifactEnvelope } from '../../shared/messages';

installChrome();

const { makeArtifact } = await import('./artifact');
const { EvaluateTool } = await import('./evaluate');
const { CdpTool } = await import('./cdp');
const { SnapshotTool } = await import('./snapshot');

const ctx = { tabId: 10, documentEpoch: 1 };

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example', title: 'A' });
});

/** 按 method 派发 CDP stub。 */
function stubCdp(handler: (method: string, params?: unknown) => unknown): () => void {
  const original = chrome.debugger.sendCommand;
  (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand =
    (async (debuggee: { tabId: number }, method: string, params?: unknown) => {
      const res = handler(method, params);
      if (res !== undefined) return res;
      return original(debuggee, method, params as object);
    }) as typeof chrome.debugger.sendCommand;
  return () => {
    (chrome.debugger as { sendCommand: typeof chrome.debugger.sendCommand }).sendCommand = original;
  };
}

describe('makeArtifact（协议 §3.5）', () => {
  it('preview 前缀裁剪 + 显式截断标记，不伪装成合法 JSON', () => {
    const data = '{"key":"' + 'v'.repeat(30_000) + '"}';
    const env = makeArtifact({
      data,
      mimeType: 'application/json',
      suggestedName: 'csi-test.json',
    });
    expect(env.artifact.encoding).toBe('utf8');
    expect(env.artifact.data).toBe(data); // data 是完整内容
    expect(env.sourceChars).toBe(data.length);
    expect(env.preview.startsWith(data.slice(0, 100))).toBe(true);
    expect(env.preview).toContain('preview truncated');
    expect(env.preview).toContain('csi-test.json');
    expect(() => JSON.parse(env.preview)).toThrow();
  });
});

describe('evaluate max_chars（协议 §4.4）', () => {
  it('未超限正常返回 {type, value}', async () => {
    const restore = stubCdp((method) =>
      method === 'Runtime.evaluate' ? { result: { type: 'string', value: 'hi' } } : undefined,
    );
    try {
      const res = (await new EvaluateTool().execute({ code: '"hi"' }, ctx)) as {
        type: string;
        value: unknown;
      };
      expect(res).toEqual({ type: 'string', value: 'hi' });
    } finally {
      restore();
    }
  });

  it('超限默认转 artifact（preview + 完整 data）', async () => {
    const big = 'x'.repeat(20_000);
    const restore = stubCdp((method) =>
      method === 'Runtime.evaluate' ? { result: { type: 'string', value: big } } : undefined,
    );
    try {
      const res = (await new EvaluateTool().execute({ code: 'big' }, ctx)) as ArtifactEnvelope;
      expect(res.artifact.suggestedName).toBe('csi-evaluate-result.json');
      expect(res.artifact.mimeType).toBe('application/json');
      expect(res.sourceChars).toBe(res.artifact.data.length);
      expect(JSON.parse(res.artifact.data)).toEqual({ type: 'string', value: big });
      expect(res.preview.length).toBeLessThan(13_000); // 默认 12000 预算存不下
      expect(() => JSON.parse(res.preview)).toThrow();
    } finally {
      restore();
    }
  });

  it('max_chars 可调到 80000 内联，越界或非法值报错', async () => {
    const big = 'x'.repeat(20_000);
    const restore = stubCdp((method) =>
      method === 'Runtime.evaluate' ? { result: { type: 'string', value: big } } : undefined,
    );
    try {
      const tool = new EvaluateTool();
      const inline = (await tool.execute({ code: 'big', max_chars: 80_000 }, ctx)) as {
        value: unknown;
      };
      expect(inline.value).toBe(big);
      for (const bad of [0, 80_001, 1.5, '100'] as unknown[]) {
        await expect(tool.execute({ code: '"x"', max_chars: bad }, ctx)).rejects.toThrow(
          /max_chars must be/,
        );
      }
    } finally {
      restore();
    }
  });
});

describe('cdp max_chars（协议 §4.2 / §4.4）', () => {
  it('数组结果包装 {value}，未超限内联', async () => {
    const restore = stubCdp((method) => (method === 'Runtime.getProperties' ? [1, 2, 3] : undefined));
    try {
      const res = (await new CdpTool().execute(
        { method: 'Runtime.getProperties' },
        ctx,
      )) as { value: unknown };
      expect(res.value).toEqual([1, 2, 3]);
    } finally {
      restore();
    }
  });

  it('超限默认转 artifact', async () => {
    const restore = stubCdp((method) =>
      method === 'DOM.getOuterHTML' ? { outerHTML: '<div>' + 'h'.repeat(20_000) + '</div>' } : undefined,
    );
    try {
      const res = (await new CdpTool().execute({ method: 'DOM.getOuterHTML' }, ctx)) as ArtifactEnvelope;
      expect(res.artifact.suggestedName).toBe('csi-cdp-result.json');
      expect(JSON.parse(res.artifact.data)).toHaveProperty('outerHTML');
      expect(() => JSON.parse(res.preview)).toThrow();
    } finally {
      restore();
    }
  });
});

describe('snapshot full 预算（协议 §4.3）', () => {
  function axNodes(longNameChars: number): unknown[] {
    const name = 'B'.repeat(longNameChars);
    const children = Array.from({ length: 20 }, (_, i) => `b${i}`);
    return [
      {
        nodeId: 'root',
        role: { value: 'RootWebArea' },
        name: { value: 'Page' },
        childIds: children,
      },
      ...children.map((id, i) => ({
        nodeId: id,
        role: { value: 'button' },
        name: { value: `${name}${i}` },
        backendDOMNodeId: 1000 + i,
      })),
    ];
  }

  function stubAx(nodes: unknown[]): () => void {
    return stubCdp((method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root', url: 'https://a.example' } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      return undefined;
    });
  }

  it('full 树 ≤80000 原样内联，新字段一致', async () => {
    const restore = stubAx(axNodes(10));
    try {
      const res = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as {
        mode: string;
        chars: number;
        source_chars: number;
        returned_chars: number;
        truncated: boolean;
        tree: unknown[];
        artifact?: unknown;
      };
      expect(res.mode).toBe('full');
      expect(res.truncated).toBe(false);
      expect(res.tree).toHaveLength(20);
      expect(res.artifact).toBeUndefined();
      expect(res.source_chars).toBe(res.chars);
      expect(res.returned_chars).toBe(res.chars);
    } finally {
      restore();
    }
  });

  it('full 树 >80000 自动转 artifact，不截断成非法 JSON', async () => {
    const restore = stubAx(axNodes(6_000)); // 20 个按钮，每个 ~6KB 名 → 远超 80000
    try {
      const res = (await new SnapshotTool().execute({ mode: 'full' }, ctx)) as {
        truncated: boolean;
        tree?: unknown;
        preview: string;
        sourceChars: number;
        source_chars: number;
        returned_chars: number;
        artifact: { encoding: string; mimeType: string; suggestedName: string; data: string };
      };
      expect(res.truncated).toBe(true);
      expect(res.tree).toBeUndefined(); // 完整树不内联
      expect(res.artifact.encoding).toBe('utf8');
      expect(res.artifact.suggestedName).toBe('csi-snapshot-full.json');
      // artifact.data 是完整合法 JSON（含 ref 分配在内的整棵树）
      const parsed = JSON.parse(res.artifact.data) as unknown[];
      expect(parsed).toHaveLength(20);
      expect(res.sourceChars).toBeGreaterThan(80_000);
      expect(res.source_chars).toBe(res.sourceChars);
      expect(res.returned_chars).toBe(res.preview.length);
      expect(res.preview).toContain('selector or match');
      expect(() => JSON.parse(res.preview)).toThrow(); // preview 不是合法 JSON
    } finally {
      restore();
    }
  });
});
