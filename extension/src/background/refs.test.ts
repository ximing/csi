import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireRemoved, installChrome, resetChromeState } from './test-chrome';
import { ToolError } from './tool-error';

installChrome();

const {
  assignRef,
  bumpEpoch,
  consumeRef,
  deleteTargetState,
  dropRefsForFrame,
  lookupRef,
  resetRefs,
} = await import('./refs');

describe('per-tab refs', () => {
  beforeEach(() => {
    resetChromeState();
    deleteTargetState(10);
    deleteTargetState(20);
  });

  it('keeps the same @e1 on two tabs independent', () => {
    assignRef(10, 111, 'button', 'A');
    assignRef(20, 222, 'button', 'B');
    expect(lookupRef(10, '@e1')?.backendDOMNodeId).toBe(111);
    expect(lookupRef(20, '@e1')?.backendDOMNodeId).toBe(222);
  });

  it('resetRefs on tab B does not clear tab A', () => {
    assignRef(10, 111, 'button', 'A');
    assignRef(20, 222, 'button', 'B');
    resetRefs(20);
    expect(lookupRef(10, '@e1')?.backendDOMNodeId).toBe(111);
    expect(lookupRef(20, '@e1')).toBeUndefined();
  });

  it('bumpEpoch turns old refs into stale_ref not unknown_ref', () => {
    assignRef(10, 111, 'button', 'A');
    bumpEpoch(10, 'navigate');
    try {
      consumeRef(10, 'click', '@e1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('stale_ref');
    }
  });

  it('unknown_ref when the key was never assigned', () => {
    try {
      consumeRef(10, 'click', '@e9');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ToolError).code).toBe('unknown_ref');
    }
  });

  it('tab 关闭事件兜底清 refs：close 瞬时失败后 tab 再死不泄漏 @e 表', () => {
    addTab({ id: 10 });
    assignRef(10, 111, 'button', 'A');
    fireRemoved(10);
    expect(lookupRef(10, '@e1')).toBeUndefined();
  });

  it('lookupRef/consumeRef 同时接受 e3（无 @ 前缀）与 @e3', () => {
    assignRef(10, 111, 'button', 'A');
    expect(lookupRef(10, 'e1')?.backendDOMNodeId).toBe(111);
    expect(consumeRef(10, 'click', 'e1').backendDOMNodeId).toBe(111);
  });

  it('dropRefsForFrame 只作废目标子帧的 ref，顶帧与其它帧不受影响', () => {
    assignRef(10, 111, 'button', 'top');
    assignRef(10, 222, 'button', 'A', 'child-1');
    assignRef(10, 333, 'button', 'B', 'child-2');
    dropRefsForFrame(10, 'child-1');
    expect(lookupRef(10, '@e1')?.backendDOMNodeId).toBe(111);
    expect(lookupRef(10, '@e2')).toBeUndefined();
    expect(lookupRef(10, '@e3')?.backendDOMNodeId).toBe(333);
  });

  it('dropRefsForFrame 对无状态的 tab 是 no-op', () => {
    expect(() => dropRefsForFrame(99, 'child-1')).not.toThrow();
  });
});
