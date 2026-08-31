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
});
