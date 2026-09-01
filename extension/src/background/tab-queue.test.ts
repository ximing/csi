import { beforeEach, describe, expect, it } from 'vitest';
import { dropTabQueue, enqueueTab, tabQueueSize } from './tab-queue';

describe('enqueueTab', () => {
  beforeEach(() => {
    dropTabQueue(10);
    dropTabQueue(20);
  });

  it('serializes two tasks on the same tab even if the second is faster', async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const first = enqueueTab(10, async () => {
      order.push(1);
      started();
      await gate;
      order.push(1.5);
    });
    const second = enqueueTab(10, async () => {
      order.push(2);
    });
    await startedP;
    expect(order).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 1.5, 2]);
  });

  it('releases the queue when the first task throws', async () => {
    const first = enqueueTab(10, async () => {
      throw new Error('boom');
    });
    const second = enqueueTab(10, async () => 'ok');
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });

  it('allows overlapping tasks on different tabs', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let bDone = false;
    const a = enqueueTab(10, async () => {
      await gateA;
    });
    const b = enqueueTab(20, async () => {
      bDone = true;
    });
    await b;
    expect(bDone).toBe(true);
    releaseA();
    await a;
  });

  it('dropTabQueue does not cancel an in-flight task', async () => {
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = enqueueTab(10, async () => {
      await gate;
      settled = true;
    });
    dropTabQueue(10);
    expect(tabQueueSize()).toBe(0);
    release();
    await run;
    expect(settled).toBe(true);
  });
});
