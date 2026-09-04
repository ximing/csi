/**
 * element.ts 共享解析助手单测：@e / CSS 两条 resolveObjectId 路径的各错误
 * 分支（unknown_ref、frame gone、stale_ref、not found、求值异常）、
 * parseFrameArg 校验、带 frameId 的 contextId 求值、scrollIntoView。
 * chrome.debugger.sendCommand 在本文件局部覆写。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, removeTabSilently, resetChromeState, stubSendCommand } from '../test-chrome';

installChrome();

const element = await import('./element');
const refs = await import('../refs');

let calls: { method: string; params: any }[] = [];
let restoreSend: (() => void) | undefined;

function stub(handlers: Record<string, (params: any) => unknown>): void {
  const s = stubSendCommand(handlers);
  calls = s.calls;
  restoreSend = s.restore;
}

afterEach(() => {
  restoreSend?.();
  restoreSend = undefined;
});

beforeEach(() => {
  resetChromeState();
  addTab({ id: 10, url: 'https://a.example' });
  refs.deleteTargetState(10);
});

describe('parseFrameArg', () => {
  it('undefined / null / 空串都视为无 frame', () => {
    expect(element.parseFrameArg('t', undefined)).toBeUndefined();
    expect(element.parseFrameArg('t', null)).toBeUndefined();
    expect(element.parseFrameArg('t', '')).toBeUndefined();
  });

  it('非字符串抛错', () => {
    expect(() => element.parseFrameArg('t', 123)).toThrow('t: frame must be a string');
  });

  it('字符串原样返回', () => {
    expect(element.parseFrameArg('t', 'child-1')).toBe('child-1');
  });
});

describe('resolveRefNode', () => {
  it('consumeRef 通过后用 backendNodeId 解析节点', async () => {
    refs.assignRef(10, 222, 'link', 'Home');
    stub({ 'DOM.resolveNode': () => ({ object: { objectId: 'obj-7' } }) });
    const node = await element.resolveRefNode('click', '@e1', 10);
    expect(node.objectId).toBe('obj-7');
    expect(node.entry.backendDOMNodeId).toBe(222);
    expect(calls[0]!.params.backendNodeId).toBe(222);
  });

  it('resolveNode 拒绝（真实 Chrome 对死 backendNodeId 的行为）→ objectId 为空，不穿透裸错', async () => {
    // 真实 Chrome 对跨文档导航后的旧 backendNodeId 是 reject
    // （"No node with given backend id"），不是返回空 object；fake 默认返回 {}
    // 掩盖了这一点。这里模拟真实行为。
    refs.assignRef(10, 222, 'link', 'Home');
    stub({
      'DOM.resolveNode': () => {
        throw new Error('No node with given backend id');
      },
    });
    const node = await element.resolveRefNode('click', '@e1', 10);
    expect(node.objectId).toBeUndefined();
  });

  it('resolveNode 拒绝「Node with given id does not belong to the document」→ objectId 为空', async () => {
    // Chromium 另一路死节点文案，不含 "no node with given"；过窄的正则会把它
    // 当 debugger 错上抛，click/fill 拿不到 stale_ref 引导重拍。
    refs.assignRef(10, 222, 'link', 'Home');
    stub({
      'DOM.resolveNode': () => {
        throw new Error('Node with given id does not belong to the document');
      },
    });
    const node = await element.resolveRefNode('click', '@e1', 10);
    expect(node.objectId).toBeUndefined();
  });

  it('resolveNode 拒绝但 tab 本身已死 → 不吞，raw 错上抛给 registry 归 stale_target', async () => {
    refs.assignRef(10, 222, 'link', 'Home');
    // tab 已死但 onRemoved 尚未送达（refs 还没被 frames.ts 的监听清掉）的竞态窗口
    removeTabSilently(10);
    stub({
      'DOM.resolveNode': () => {
        throw new Error('No node with given backend id');
      },
    });
    await expect(element.resolveRefNode('click', '@e1', 10)).rejects.toThrow(/no tab 10/);
  });

  it('resolveNode 因 debugger 断开拒绝（tab 活着）→ 不吞，raw 错上抛，不得误读成节点不在', async () => {
    // 用户点了「正在调试此浏览器」横幅的取消 / renderer 崩溃：错误语义是
    // 「调试会话断了」，吞成 objectId 空会让 click/fill 误报 stale_ref、
    // wait gone:true 假命中（元素其实还在页面上）。
    refs.assignRef(10, 222, 'link', 'Home');
    stub({
      'DOM.resolveNode': () => {
        throw new Error('Debugger is not attached');
      },
    });
    await expect(element.resolveRefNode('click', '@e1', 10)).rejects.toThrow(
      /Debugger is not attached/,
    );
  });
});

describe('resolveObjectId @e 路径', () => {
  it('解析成功返回 objectId', async () => {
    refs.assignRef(10, 111, 'button', 'Go');
    stub({ 'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }) });
    await expect(element.resolveObjectId('click', '@e1', 10)).resolves.toBe('obj-1');
  });

  it('未 snapshot 的 ref 抛 unknown_ref ToolError', async () => {
    await expect(element.resolveObjectId('click', '@e99', 10)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'unknown_ref',
    });
  });

  it('节点不可解析且 ref 带子帧 frameId → frame gone', async () => {
    refs.assignRef(10, 111, 'button', 'A', 'child-frame-1');
    stub({ 'DOM.resolveNode': () => ({}) });
    await expect(element.resolveObjectId('click', '@e1', 10)).rejects.toThrow(/frame is gone/);
  });

  it('节点不可解析且为顶层节点 → stale_ref ToolError', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    stub({ 'DOM.resolveNode': () => ({}) });
    await expect(element.resolveObjectId('click', '@e1', 10)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'stale_ref',
    });
  });

  it('resolveNode 拒绝（死节点）+ 顶层节点 → stale_ref ToolError（协议 §3.3 引导重拍）', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    stub({
      'DOM.resolveNode': () => {
        throw new Error('No node with given backend id');
      },
    });
    await expect(element.resolveObjectId('click', '@e1', 10)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'stale_ref',
    });
  });

  it('resolveNode 拒绝（死节点）+ 子帧节点 → frame gone', async () => {
    refs.assignRef(10, 111, 'button', 'A', 'child-frame-1');
    stub({
      'DOM.resolveNode': () => {
        throw new Error('No node with given backend id');
      },
    });
    await expect(element.resolveObjectId('click', '@e1', 10)).rejects.toThrow(/frame is gone/);
  });
});

describe('resolveObjectId CSS 路径', () => {
  it('命中返回 objectId（returnByValue:false）', async () => {
    stub({ 'Runtime.evaluate': () => ({ result: { objectId: 'obj-2' } }) });
    await expect(element.resolveObjectId('click', '#btn', 10)).resolves.toBe('obj-2');
    expect(calls[0]!.params.expression).toBe('document.querySelector("#btn")');
    expect(calls[0]!.params.returnByValue).toBe(false);
    expect('contextId' in calls[0]!.params).toBe(false);
  });

  it('求值异常 → 抛 exceptionDetails 文本', async () => {
    stub({ 'Runtime.evaluate': () => ({ exceptionDetails: { text: 'Syntax err' } }) });
    await expect(element.resolveObjectId('click', '#btn', 10)).rejects.toThrow('click: Syntax err');
  });

  it('subtype null / 无 objectId → element not found', async () => {
    stub({ 'Runtime.evaluate': () => ({ result: { subtype: 'null', objectId: 'x' } }) });
    await expect(element.resolveObjectId('click', '#btn', 10)).rejects.toThrow(
      'click: element not found: #btn',
    );

    stub({ 'Runtime.evaluate': () => ({ result: {} }) });
    await expect(element.resolveObjectId('click', '#btn', 10)).rejects.toThrow(
      'click: element not found: #btn',
    );
  });

  it('带 frameId：用该帧默认 context 的 contextId 求值', async () => {
    // 预置 child-1 帧的默认执行上下文，contextIdForFrame 直接命中缓存。
    fireDebuggerEvent(10, 'Runtime.executionContextCreated', {
      context: { id: 42, auxData: { frameId: 'child-1', isDefault: true } },
    });
    stub({ 'Runtime.evaluate': () => ({ result: { objectId: 'obj-3' } }) });
    await expect(element.resolveObjectId('click', '#btn', 10, 'child-1')).resolves.toBe('obj-3');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.contextId).toBe(42);
  });
});

describe('scrollIntoView', () => {
  it('发 callFunctionOn 居中滚动到该 objectId', async () => {
    stub({});
    await element.scrollIntoView(10, 'obj-9');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.objectId).toBe('obj-9');
    expect(calls[0]!.params.functionDeclaration).toContain("scrollIntoView({ block: 'center', inline: 'center' })");
  });
});
