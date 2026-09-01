import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignRef,
  bumpEpoch,
  consumeRef,
  deleteTargetState,
  lookupRef,
  resetRefs,
} from './refs';
import { ToolError } from './tool-error';

describe('per-tab refs', () => {
  beforeEach(() => {
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
});
