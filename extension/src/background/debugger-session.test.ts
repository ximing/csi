import { beforeEach, describe, expect, it } from 'vitest';
import { addTab, debuggerCalls, installChrome, resetChromeState } from './test-chrome';

installChrome();

const { sendCommand, ensureAttached } = await import('./debugger-session');

describe('sendCommand tabId', () => {
  beforeEach(() => {
    resetChromeState();
    addTab({ id: 10, url: 'https://a.example' });
    addTab({ id: 20, url: 'https://b.example' });
  });

  it('sends CDP to the explicit tab, not a global current', async () => {
    await ensureAttached(10);
    await sendCommand(10, 'Runtime.evaluate', { expression: '1' });
    await sendCommand(20, 'Runtime.evaluate', { expression: '2' });
    const evals = debuggerCalls.filter((c) => c.method === 'Runtime.evaluate');
    expect(evals.map((c) => c.tabId)).toEqual([10, 20]);
  });
});
