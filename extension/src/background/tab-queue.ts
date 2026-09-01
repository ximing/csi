/**
 * Per-tab promise queue (protocol §3.4 concurrency). Occupancy lasts until
 * the tool promise settles — not until the daemon HTTP timeout.
 * dropTabQueue only deletes the Map entry; it does not cancel in-flight work.
 */

const tails = new Map<number, Promise<void>>();

export function enqueueTab<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(tabId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(tabId, tail);
  return run;
}

/** Remove the Map entry so a closed tab does not leak. Does not cancel promises. */
export function dropTabQueue(tabId: number): void {
  tails.delete(tabId);
}

/** Test helper: number of queued tails. */
export function tabQueueSize(): number {
  return tails.size;
}
