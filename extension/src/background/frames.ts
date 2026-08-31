// 0.6.0 同域 iframe（协议 §4.1）：帧发现、isolated 判定、default-world contextId 表。按 tab 分区。

import { forgetAttached, sendCommand } from './debugger-session';
import { bumpEpoch, deleteTargetState } from './refs';
import { dropTabQueue } from './tab-queue';

export interface FrameInfo {
  frameId: string;
  parentId: string;
  url: string;
  name: string;
  isolated: boolean;
}

export const FRAME_GONE_ERROR = 'iframe: frame is gone; run snapshot again';

export function crossOriginError(url: string): Error {
  return new Error(
    `iframe: cross-origin frame "${url || 'unknown'}" is not supported yet. ` +
      'If it is a full page, navigate to its URL.',
  );
}

interface CdpFrame {
  id: string;
  parentId?: string;
  url: string;
  name?: string;
  securityOrigin?: string;
}

interface FrameTreeNode {
  frame: CdpFrame;
  childFrames?: FrameTreeNode[];
}

async function localFrames(tabId: number): Promise<CdpFrame[]> {
  const { frameTree } = await sendCommand<{ frameTree: FrameTreeNode }>(
    tabId,
    'Page.getFrameTree',
  );
  const out: CdpFrame[] = [];
  const walk = (node: FrameTreeNode): void => {
    out.push(node.frame);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return out;
}

interface DomIframeRow {
  src: string;
  name: string;
  sandbox: string | null;
  sameDoc: boolean;
}

async function domIframeRows(tabId: number): Promise<DomIframeRow[]> {
  const res = await sendCommand<{ result?: { value?: DomIframeRow[] } }>(tabId, 'Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe,frame')].map((f) => ({
      src: f.src || '',
      name: f.name || f.id || '',
      sandbox: f.getAttribute('sandbox'),
      sameDoc: f.contentDocument != null,
    }))`,
    returnByValue: true,
  });
  return res.result?.value ?? [];
}

async function oopifUrls(tabId: number): Promise<string[]> {
  const targets = await chrome.debugger.getTargets();
  return targets
    .filter((t) => t.type === 'iframe' && t.tabId === tabId && t.url)
    .map((t) => t.url);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function judgeIsolated(f: CdpFrame, topOrigin: string, row: DomIframeRow | undefined): boolean {
  if (!f.securityOrigin || f.securityOrigin === '://' || f.securityOrigin === 'null') return true;
  if (f.url.startsWith('data:')) return true;
  if (row && row.sandbox !== null && !/\ballow-same-origin\b/.test(row.sandbox)) return true;
  if (row && !row.sameDoc) return true;
  if (!topOrigin || topOrigin === 'null') return true;
  return f.securityOrigin !== topOrigin;
}

export async function listAllFrames(tabId: number): Promise<FrameInfo[]> {
  const [locals, domRows, oopifs] = await Promise.all([
    localFrames(tabId),
    domIframeRows(tabId),
    oopifUrls(tabId),
  ]);
  const top = locals.find((f) => !f.parentId);
  const topOrigin = top ? safeOrigin(top.url) : '';

  const frames: FrameInfo[] = locals.map((f) => {
    const row = f.parentId ? domRows.find((r) => r.src && r.src === f.url) : undefined;
    return {
      frameId: f.id,
      parentId: f.parentId ?? '',
      url: f.url,
      name: f.name || row?.name || '',
      isolated: f.parentId ? judgeIsolated(f, topOrigin, row) : false,
    };
  });

  const known = new Set(frames.map((f) => f.url));
  for (const row of domRows) {
    if (row.src && !known.has(row.src)) {
      frames.push({
        frameId: `isolated:${row.src}`,
        parentId: top?.id ?? '',
        url: row.src,
        name: row.name,
        isolated: true,
      });
      known.add(row.src);
    }
  }
  for (const url of oopifs) {
    if (!known.has(url)) {
      frames.push({
        frameId: `isolated:${url}`,
        parentId: top?.id ?? '',
        url,
        name: '',
        isolated: true,
      });
      known.add(url);
    }
  }
  return frames;
}

export async function findFrame(tabId: number, value: string): Promise<FrameInfo> {
  const all = (await listAllFrames(tabId)).filter(
    (f) => f.parentId !== '' || f.frameId.startsWith('isolated:'),
  );
  const exact = all.filter((f) => f.frameId === value);
  const hits = exact.length > 0 ? exact : all.filter((f) => f.url.includes(value));
  if (hits.length === 0) throw new Error(`iframe: no frame matching "${value}"`);
  if (hits.length > 1) {
    const urls = hits
      .slice(0, 5)
      .map((f) => f.url)
      .join(', ');
    throw new Error(`iframe: multiple frames match "${value}": ${urls}`);
  }
  return hits[0]!;
}

export async function resolveFrame(tabId: number, value: string): Promise<FrameInfo> {
  const f = await findFrame(tabId, value);
  if (f.isolated) throw crossOriginError(f.url);
  return f;
}

export async function frameById(tabId: number, frameId: string): Promise<FrameInfo> {
  const f = (await listAllFrames(tabId)).find((x) => x.frameId === frameId);
  if (!f) throw new Error(FRAME_GONE_ERROR);
  return f;
}

export async function isolatedSrcSet(tabId: number): Promise<Set<string>> {
  const all = await listAllFrames(tabId);
  return new Set(all.filter((f) => f.isolated && f.url).map((f) => f.url));
}

const contextByFrame = new Map<string, number>();
const contextWaiters = new Map<string, ((id: number) => void)[]>();

function contextKey(tabId: number, frameId: string): string {
  return `${tabId}:${frameId}`;
}

export function clearContextsForTab(tabId: number): void {
  const prefix = `${tabId}:`;
  for (const key of [...contextByFrame.keys()]) {
    if (key.startsWith(prefix)) contextByFrame.delete(key);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === 'Runtime.executionContextCreated') {
    const ctx = (
      params as {
        context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
      }
    ).context;
    const frameId = ctx?.auxData?.frameId;
    if (ctx?.id != null && frameId && ctx.auxData?.isDefault) {
      const key = contextKey(tabId, frameId);
      contextByFrame.set(key, ctx.id);
      const waiters = contextWaiters.get(key) ?? [];
      contextWaiters.delete(key);
      for (const w of waiters) w(ctx.id);
    }
  } else if (method === 'Runtime.executionContextsCleared') {
    clearContextsForTab(tabId);
  } else if (method === 'Page.frameNavigated') {
    const frame = (params as { frame?: { parentId?: string } }).frame;
    if (frame && !frame.parentId) {
      bumpEpoch(tabId, 'navigate');
      clearContextsForTab(tabId);
    } else if (frame?.parentId) {
      bumpEpoch(tabId, 'navigate');
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetAttached(tabId);
  deleteTargetState(tabId);
  dropTabQueue(tabId);
  clearContextsForTab(tabId);
});

chrome.debugger.onDetach.addListener((debuggee) => {
  if (!debuggee.tabId) return;
  forgetAttached(debuggee.tabId);
  bumpEpoch(debuggee.tabId, 'reattach');
  clearContextsForTab(debuggee.tabId);
});

export async function contextIdForFrame(tabId: number, frameId: string): Promise<number> {
  const key = contextKey(tabId, frameId);
  const cached = contextByFrame.get(key);
  if (cached != null) return cached;

  const waiting = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    const list = contextWaiters.get(key) ?? [];
    list.push((id) => {
      clearTimeout(timer);
      resolve(id);
    });
    contextWaiters.set(key, list);
  });
  await sendCommand(tabId, 'Runtime.disable');
  await sendCommand(tabId, 'Runtime.enable');
  const refreshed = await waiting;
  if (refreshed != null) return refreshed;

  const { executionContextId } = await sendCommand<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId, worldName: 'csi-frame', grantUniveralAccess: true },
  );
  return executionContextId;
}
