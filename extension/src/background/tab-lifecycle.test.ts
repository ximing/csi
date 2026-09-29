import { afterEach, expect, it, vi } from 'vitest';
import { installChrome, fireRemoved } from './test-chrome';
installChrome();
afterEach(() => vi.restoreAllMocks());

it('Chrome 关闭事件与显式清理走同一路径，detach 只通知对应处理器', async () => {
  const { registerTabLifecycle, removeTabState, detachTabState } = await import('./tab-lifecycle');
  const removed = vi.fn();
  const detached = vi.fn();
  const unregister = registerTabLifecycle({ removed, detached });
  fireRemoved(10);
  removeTabState(10);
  detachTabState(20);
  expect(removed.mock.calls).toEqual([[10], [10]]);
  expect(detached.mock.calls).toEqual([[20]]);
  unregister();
  removeTabState(30);
  expect(removed).toHaveBeenCalledTimes(2);
});

it('一个清理器失败不阻止其余清理器', async () => {
  const { registerTabLifecycle, removeTabState } = await import('./tab-lifecycle');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const off1 = registerTabLifecycle({ removed: () => { throw new Error('cleanup failed'); } });
  const removed = vi.fn();
  const off2 = registerTabLifecycle({ removed });
  removeTabState(10);
  expect(removed).toHaveBeenCalledWith(10);
  expect(log).toHaveBeenCalled();
  off1(); off2();
});

it('detach 作废引用和 attached 状态，但保留活 tab 队列；关闭才完整清理', async () => {
  const { addTab, fireDebuggerDetach } = await import('./test-chrome');
  const debuggerSession = await import('./debugger-session');
  const refs = await import('./refs');
  const queue = await import('./tab-queue');
  addTab({ id: 80, url: 'https://example.com' });
  await debuggerSession.ensureAttached(80);
  const ref = refs.assignRef(80, 100, 'button', 'submit');
  let finish!: () => void;
  const pending = queue.enqueueTab(80, () => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const before = queue.tabQueueSize();
  fireDebuggerDetach(80);
  expect(debuggerSession.isAttached(80)).toBe(false);
  expect(() => refs.consumeRef(80, 'click', ref)).toThrow();
  expect(queue.tabQueueSize()).toBe(before);
  fireRemoved(80);
  expect(queue.tabQueueSize()).toBe(before - 1);
  finish();
  await pending;
});
