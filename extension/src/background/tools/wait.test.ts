/**
 * wait 工具层测试（协议 §4 wait、§3.3 错误契约）：
 * 未知/过期 @e 立刻失败且带 code；poll 只吞「元素未找到」，ToolError 原样上抛；
 * gone:true 下节点已从文档移除算命中；
 * 三类条件（text/selector/url）的命中与超时路径、参数校验、瞬时错误重试。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTab,
  fireDebuggerEvent,
  fireRemoved,
  installChrome,
  resetChromeState,
  stubSendCommand,
} from '../test-chrome';

installChrome();

const { WaitTool } = await import('./wait');
const refs = await import('../refs');

const ctx = { tabId: 10, documentEpoch: 1 };

/** 正的 border quad（宽 100 高 100）。 */
const GOOD_QUAD = [0, 0, 100, 0, 100, 100, 0, 100];

type CdpHandler = (params: Record<string, any>) => unknown;

/** 局部覆写 chrome.debugger.sendCommand：按 method 分发，未命中的走原 fake。 */
function stubCdp(handlers: Record<string, CdpHandler>): () => void {
  return stubSendCommand(handlers).restore;
}

/** wait 命中所需的默认 CDP 响应：CSS 查询 → box → 非 aria-hidden。 */
function selectorHitHandlers(): Record<string, CdpHandler> {
  return {
    'Runtime.evaluate': (p) => ({ result: { objectId: 'o1' }, internal: p }),
    'DOM.getBoxModel': () => ({ model: { border: GOOD_QUAD } }),
    'Runtime.callFunctionOn': () => ({ result: { value: false } }),
  };
}

let restoreCdp: (() => void) | undefined;

afterEach(() => {
  restoreCdp?.();
  restoreCdp = undefined;
});

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

describe('wait @e 错误契约', () => {
  it('未知 @e 立刻失败：ToolError unknown_ref', async () => {
    await expect(new WaitTool().execute({ selector: '@e9' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'unknown_ref',
    });
  });

  it('过期 @e 立刻失败：stale_ref 而不是全程超时', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    refs.bumpEpoch(10, 'navigate');
    await expect(new WaitTool().execute({ selector: '@e1' }, ctx)).rejects.toMatchObject({
      code: 'stale_ref',
    });
  });

  it('轮询中途导航：stale_ref 原样上抛，不被吞成 timeout', async () => {
    refs.assignRef(10, 111, 'button', 'A'); // fake DOM.resolveNode 返回 {} → 节点不可解析，持续未命中
    const pending = new WaitTool().execute(
      { selector: '@e1', timeout_ms: 2000, interval_ms: 50 },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 120));
    refs.bumpEpoch(10, 'navigate');
    await expect(pending).rejects.toMatchObject({ code: 'stale_ref' });
  });

  it('gone:true 且节点已从同文档移除 → 命中成功', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    const res = (await new WaitTool().execute(
      { selector: '@e1', gone: true, timeout_ms: 300, interval_ms: 50 },
      ctx,
    )) as { success: boolean; matched: string };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('gone:selector:@e1');
  });

  it('gone:true 但 resolveNode 是 debugger 断开错误 → 不假命中成功（元素还在页面上）', async () => {
    // resolveRefNode 若把「Debugger is not attached」吞成「节点不在」，
    // gone:true 会立刻返回成功——元素其实还在。真实语义是轮询遇瞬时错误
    // 继续等，烧到 timeout 报错。
    refs.assignRef(10, 111, 'button', 'A');
    restoreCdp = stubCdp({
      'DOM.resolveNode': () => {
        throw new Error('Debugger is not attached');
      },
    });
    await expect(
      new WaitTool().execute({ selector: '@e1', gone: true, timeout_ms: 300, interval_ms: 50 }, ctx),
    ).rejects.toThrow(/timed out after 300ms/);
  });
});

describe('wait 轮询期间 tab 死亡（协议 §3.3/§3.4）', () => {
  it('tab 在轮询中途被关 → 立刻 stale_target，不把裸错当未命中烧满 timeout', async () => {
    const started = Date.now();
    const pending = new WaitTool().execute(
      { url: 'never-matches', timeout_ms: 5000, interval_ms: 50, _session: 's' },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 120));
    fireRemoved(10);
    await expect(pending).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('@e 轮询中途 tab 被关（onRemoved 清 ref 表）→ stale_target，不是 unknown_ref', async () => {
    // consumeRef 在 execute 开头已成功；onRemoved 清掉 ref 后下一轮
    // resolveRefNode 抛 unknown_ref（ToolError）。若 asStaleTarget 对
    // ToolError 直接放行，daemon 收不到 ForgetTab。
    refs.assignRef(10, 111, 'button', 'A');
    restoreCdp = stubCdp({
      'DOM.resolveNode': () => ({}), // 节点解析为空 → 未命中，继续轮询
    });
    const pending = new WaitTool().execute(
      { selector: '@e1', timeout_ms: 5000, interval_ms: 50, _session: 's' },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 80));
    fireRemoved(10);
    await expect(pending).rejects.toMatchObject({
      code: 'stale_target',
      details: { tabId: 10, session: 's' },
    });
  });
});

describe('wait 条件选择与参数校验（协议 §4）', () => {
  it('一个条件都不给 → 报错', async () => {
    await expect(new WaitTool().execute({}, ctx)).rejects.toThrow(
      /exactly one of text, selector, url/,
    );
  });

  it('同时给两个条件 → 报错', async () => {
    await expect(
      new WaitTool().execute({ text: 'a', url: 'b' }, ctx),
    ).rejects.toThrow(/exactly one of text, selector, url/);
  });

  it('空字符串不算条件', async () => {
    await expect(new WaitTool().execute({ text: '', selector: '' }, ctx)).rejects.toThrow(
      /exactly one of text, selector, url/,
    );
  });

  it.each(['x', 50, 130_000, 1.5])('timeout_ms 非法值 %s → 报错', async (raw) => {
    await expect(
      new WaitTool().execute({ url: 'a.example', timeout_ms: raw } as Record<string, unknown>, ctx),
    ).rejects.toThrow(/timeout_ms must be an integer between 100 and 120000/);
  });

  it('timeout_ms null/undefined 走默认值（合法）', async () => {
    const res = (await new WaitTool().execute({ url: 'a.example', timeout_ms: null }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it.each([10, 3000, 'x', 1.5])('interval_ms 非法值 %s → 报错', async (raw) => {
    await expect(
      new WaitTool().execute({ url: 'x', interval_ms: raw } as Record<string, unknown>, ctx),
    ).rejects.toThrow(/interval_ms must be an integer between 50 and 2000/);
  });

  it('frame 非字符串 → 报错', async () => {
    await expect(
      new WaitTool().execute({ url: 'x', frame: 5 } as Record<string, unknown>, ctx),
    ).rejects.toThrow(/frame must be a string/);
  });
});

describe('wait url 条件（协议 §4.1：url 不看 frame，看 tab URL）', () => {
  it('url 命中立即成功', async () => {
    const res = (await new WaitTool().execute({ url: 'a.example' }, ctx)) as {
      success: boolean;
      matched: string;
    };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('url:a.example');
  });

  it('url 不命中 → 超时报错，带 last url', async () => {
    await expect(
      new WaitTool().execute({ url: 'nope', timeout_ms: 200, interval_ms: 50 }, ctx),
    ).rejects.toThrow(
      /timed out after 200ms waiting for url "nope" \(last url: https:\/\/a\.example\)/,
    );
  });

  it('url 条件忽略 frame 参数（不解析帧）', async () => {
    // 不给 Page.getFrameTree 处理器：若真的去 resolveFrame 会炸，url 命中说明没去。
    const res = (await new WaitTool().execute({ url: 'a.example', frame: 'whatever' }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('tab 无 url 时 last url 为空串', async () => {
    resetChromeState();
    addTab({ id: 10 });
    await expect(
      new WaitTool().execute({ url: 'nope', timeout_ms: 150, interval_ms: 50 }, ctx),
    ).rejects.toThrow(/timed out after 150ms waiting for url "nope" \(last url: \)/);
  });
});

describe('wait text 条件（协议 §4）', () => {
  it('innerText 命中立即成功', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': (p) =>
        String(p.expression).includes('innerText') ? { result: { value: true } } : { result: { value: [] } },
    });
    const res = (await new WaitTool().execute({ text: 'Hello' }, ctx)) as {
      success: boolean;
      matched: string;
    };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('text:Hello');
  });

  it('innerText 未命中但 AX 树 name 命中 → 成功', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { value: false } }),
      'Accessibility.getFullAXTree': (p) => {
        expect(p.frameId).toBeUndefined(); // 顶层等待不带 frameId
        return { nodes: [{ name: { value: 'Welcome, Hello!' } }] };
      },
    });
    const res = (await new WaitTool().execute({ text: 'Hello' }, ctx)) as { success: boolean };
    expect(res.success).toBe(true);
  });

  it('innerText evaluate 抛异常 → 回退 AX 树按 name 匹配', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ exceptionDetails: { text: 'boom' } }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [{ role: { value: 'heading' }, name: { value: 'Hello world' } }],
      }),
    });
    const res = (await new WaitTool().execute({ text: 'Hello' }, ctx)) as { success: boolean };
    expect(res.success).toBe(true);
  });

  it('innerText 与 AX 树都未命中 → 超时', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { value: false } }),
      'Accessibility.getFullAXTree': () => ({
        nodes: [{ role: { value: 'img' } }, { name: { value: '别的' } }], // 无 name 节点被跳过
      }),
    });
    await expect(
      new WaitTool().execute({ text: 'Nope', timeout_ms: 200, interval_ms: 50 }, ctx),
    ).rejects.toThrow(/timed out after 200ms waiting for text "Nope"/);
  });

  it('text + frame：evaluate 带 contextId、AX 树带 frameId（协议 §4.1）', async () => {
    // 预置 child 帧的 default context，避免 contextIdForFrame 走 1s 等待
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 7, auxData: { frameId: 'child', isDefault: true } },
    });
    let seenContextId: unknown;
    let seenFrameId: unknown;
    restoreCdp = stubCdp({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'root', url: 'https://a.example' },
          childFrames: [
            { frame: { id: 'child', parentId: 'root', url: 'https://a.example/embed', securityOrigin: 'https://a.example' } },
          ],
        },
      }),
      'Runtime.evaluate': (p) => {
        if (String(p.expression).includes('querySelectorAll')) return { result: { value: [] } };
        if (String(p.expression).includes('innerText')) {
          seenContextId = p.contextId;
          return { result: { value: false } };
        }
        return { result: { value: null } };
      },
      'Accessibility.getFullAXTree': (p) => {
        seenFrameId = p.frameId;
        return { nodes: [{ name: { value: 'Hello in frame' } }] };
      },
    });
    const res = (await new WaitTool().execute({ text: 'Hello', frame: 'child' }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
    expect(seenContextId).toBe(7);
    expect(seenFrameId).toBe('child');
  });

  it('瞬时 CDP 错误（tab 仍在）当未命中，下一轮命中', async () => {
    let calls = 0;
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => {
        calls += 1;
        if (calls === 1) throw new Error('transient renderer hiccup');
        return { result: { value: true } };
      },
    });
    const res = (await new WaitTool().execute(
      { text: 'Hello', timeout_ms: 2000, interval_ms: 50 },
      ctx,
    )) as { success: boolean; waitedMs: number };
    expect(res.success).toBe(true);
    // 断言轮询了第二轮，而不是墙钟 ≥ interval：setTimeout(50) 可能早 1ms 触发。
    expect(calls).toBe(2);
    expect(res.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('超时后取 last url 时 tab 已被关 → last url 空串', async () => {
    // text 走 CDP（不经 tabs）：tab 关掉后 CDP stub 仍返回未命中，
    // 烧到超时再取 tabs.get 才发现 tab 没了。
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { value: false } }),
      'Accessibility.getFullAXTree': () => ({}), // 无 nodes 键 → 空数组兜底
    });
    const pending = new WaitTool().execute(
      { text: 'Nope', timeout_ms: 250, interval_ms: 50 },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 60));
    fireRemoved(10);
    await expect(pending).rejects.toThrow(/timed out after 250ms waiting for text "Nope" \(last url: \)/);
  });
});

describe('wait CSS selector 条件（协议 §4）', () => {
  it('选择器命中：querySelector → 正 box → 非 aria-hidden', async () => {
    restoreCdp = stubCdp(selectorHitHandlers());
    const res = (await new WaitTool().execute({ selector: '#btn' }, ctx)) as {
      success: boolean;
      matched: string;
    };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('selector:#btn');
  });

  it('gone:true 等元素消失：选择器一直查不到 → 立即成功', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { subtype: 'null' } }),
    });
    const res = (await new WaitTool().execute({ selector: '#gone', gone: true }, ctx)) as {
      success: boolean;
      matched: string;
    };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('gone:selector:#gone');
  });

  it('querySelector evaluate 抛异常 → 未命中（gone:true 成功）', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': (p) =>
        String(p.expression).includes('document.querySelector')
          ? { exceptionDetails: { text: 'bad selector' } }
          : { result: { value: [] } },
    });
    const res = (await new WaitTool().execute({ selector: '##bad', gone: true }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('CSS + frame：querySelector 的 evaluate 带 contextId', async () => {
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 9, auxData: { frameId: 'child', isDefault: true } },
    });
    let seenContextId: unknown;
    restoreCdp = stubCdp({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'root', url: 'https://a.example' },
          childFrames: [
            { frame: { id: 'child', parentId: 'root', url: 'https://a.example/embed', securityOrigin: 'https://a.example' } },
          ],
        },
      }),
      'Runtime.evaluate': (p) => {
        if (String(p.expression).includes('querySelectorAll')) return { result: { value: [] } };
        if (String(p.expression).includes('document.querySelector')) {
          seenContextId = p.contextId;
          return { result: { objectId: 'o1' } };
        }
        return { result: { value: null } };
      },
      'DOM.getBoxModel': () => ({ model: { border: GOOD_QUAD } }),
      'Runtime.callFunctionOn': () => ({ result: { value: false } }),
    });
    const res = (await new WaitTool().execute({ selector: '#btn', frame: 'child' }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
    expect(seenContextId).toBe(9);
  });

  it('DOM.getBoxModel 节点无布局 → 未命中（gone:true 成功）', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => {
        throw new Error('Could not compute box model.');
      },
    });
    const res = (await new WaitTool().execute({ selector: '#btn', gone: true }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('gone:true 但 getBoxModel 是 debugger 断开 → 不假命中成功', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => {
        throw new Error('Debugger is not attached');
      },
    });
    await expect(
      new WaitTool().execute({ selector: '#btn', gone: true, timeout_ms: 300, interval_ms: 50 }, ctx),
    ).rejects.toThrow(/timed out after 300ms/);
  });

  it('box 全零（不可见）→ 未命中（gone:true 成功）', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => ({ model: { border: [0, 0, 0, 0, 0, 0, 0, 0] } }),
    });
    const res = (await new WaitTool().execute({ selector: '#btn', gone: true }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('box model 无 border/content quad → 未命中（gone:true 成功）', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => ({ model: {} }),
    });
    const res = (await new WaitTool().execute({ selector: '#btn', gone: true }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('border quad 不足 8 数但 content quad 有效 → 仍命中', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => ({ model: { border: [0, 0, 5], content: GOOD_QUAD } }),
      'Runtime.callFunctionOn': () => ({ result: { value: false } }),
    });
    const res = (await new WaitTool().execute({ selector: '#btn' }, ctx)) as { success: boolean };
    expect(res.success).toBe(true);
  });

  it('aria-hidden=true → 未命中（gone:true 成功）', async () => {
    restoreCdp = stubCdp({
      'Runtime.evaluate': () => ({ result: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => ({ model: { border: GOOD_QUAD } }),
      'Runtime.callFunctionOn': () => ({ result: { value: true } }),
    });
    const res = (await new WaitTool().execute({ selector: '#btn', gone: true }, ctx)) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });
});

describe('wait @e selector 条件', () => {
  it('@e 解析到节点且可见 → 命中成功', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    restoreCdp = stubCdp({
      'DOM.resolveNode': () => ({ object: { objectId: 'o1' } }),
      'DOM.getBoxModel': () => ({ model: { border: GOOD_QUAD } }),
      'Runtime.callFunctionOn': () => ({ result: { value: false } }),
    });
    const res = (await new WaitTool().execute({ selector: '@e1' }, ctx)) as {
      success: boolean;
      matched: string;
    };
    expect(res.success).toBe(true);
    expect(res.matched).toBe('selector:@e1');
  });

  it('@e 自带帧信息：frame 参数被忽略（不给帧树 stub 也能 gone 成功）', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    restoreCdp = stubCdp({
      'DOM.resolveNode': () => ({ object: {} }), // 节点已移除 → 未命中
    });
    const res = (await new WaitTool().execute(
      { selector: '@e1', gone: true, frame: 'whatever' },
      ctx,
    )) as { success: boolean };
    expect(res.success).toBe(true);
  });
});
