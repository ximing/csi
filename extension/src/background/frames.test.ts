import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, fireDebuggerEvent, installChrome, resetChromeState } from './test-chrome';

installChrome();

const frames = await import('./frames');
const refs = await import('./refs');

describe('frame context isolation', () => {
  beforeEach(() => {
    resetChromeState();
    addTab({ id: 10, url: 'https://a.example' });
    addTab({ id: 20, url: 'https://b.example' });
    refs.deleteTargetState(10);
    refs.deleteTargetState(20);
  });

  it('executionContextsCleared on tab 20 does not bump tab 10 refs to stale', async () => {
    refs.assignRef(10, 111, 'button', 'A');
    fireDebuggerEvent(20, 'Runtime.executionContextsCleared', {});
    expect(refs.consumeRef(10, 'click', '@e1').backendDOMNodeId).toBe(111);
  });

  it('main-document frameNavigated on tab 10 stale-refs only that tab', () => {
    refs.assignRef(10, 111, 'button', 'A');
    refs.assignRef(20, 222, 'button', 'B');
    fireDebuggerEvent(10, 'Page.frameNavigated', { frame: { id: 'root' } });
    expect(() => refs.consumeRef(10, 'click', '@e1')).toThrow(/stale ref/);
    expect(refs.consumeRef(20, 'click', '@e1').backendDOMNodeId).toBe(222);
  });

  it('child frameNavigated does not bump the tab epoch (top-page refs stay valid)', () => {
    refs.assignRef(10, 111, 'button', 'A');
    fireDebuggerEvent(10, 'Page.frameNavigated', {
      frame: { id: 'child-1', parentId: 'root' },
    });
    expect(refs.consumeRef(10, 'click', '@e1').backendDOMNodeId).toBe(111);
  });

  it('child frameNavigated drops only that frame’s refs', () => {
    refs.assignRef(10, 111, 'button', 'top'); // @e1 顶层
    refs.assignRef(10, 222, 'button', 'in-frame', 'child-1'); // @e2 子帧
    refs.assignRef(10, 333, 'button', 'other-frame', 'child-2'); // @e3 另一子帧
    fireDebuggerEvent(10, 'Page.frameNavigated', {
      frame: { id: 'child-1', parentId: 'root' },
    });
    expect(refs.consumeRef(10, 'click', '@e1').backendDOMNodeId).toBe(111);
    expect(() => refs.consumeRef(10, 'click', '@e2')).toThrow(/unknown ref/);
    expect(refs.consumeRef(10, 'click', '@e3').backendDOMNodeId).toBe(333);
  });
});
