// 0.6.0 同域 iframe（协议 §4.1）：帧发现（getFrameTree ∪ 顶层 DOM iframe 行 ∪ debugger.getTargets）、isolated 判定（fail closed）、default-world contextId 表。只服务 tab 会话，禁止 attach OOPIF target。

import { getAttachedTabId, sendCommand } from './debugger-session';
import { resetRefs } from './refs';

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

// ---------- 帧发现（规格：发现源不能只靠 getFrameTree） ----------

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

async function localFrames(): Promise<CdpFrame[]> {
  const { frameTree } = await sendCommand<{ frameTree: FrameTreeNode }>('Page.getFrameTree');
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

/** 顶层文档里的 iframe/frame 元素（跨域的 contentDocument 返回 null，不抛）。 */
async function domIframeRows(): Promise<DomIframeRow[]> {
  const res = await sendCommand<{ result?: { value?: DomIframeRow[] } }>('Runtime.evaluate', {
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

/** OOPIF 的 url（type=iframe）。绝不把 targetId 带进返回值（协议 §4）。 */
async function oopifUrls(): Promise<string[]> {
  const tabId = getAttachedTabId();
  const targets = await chrome.debugger.getTargets();
  return targets
    .filter((t) => t.type === 'iframe' && t.tabId === tabId && t.url)
    .map((t) => t.url);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin; // 不透明源返回 "null"
  } catch {
    return '';
  }
}

// ---------- isolated 判定（fail closed，规格 §扩展实现） ----------

function judgeIsolated(f: CdpFrame, topOrigin: string, row: DomIframeRow | undefined): boolean {
  // 2. 不透明源（sandbox 无 allow-same-origin 的 srcdoc/about:blank、data: 等）
  if (!f.securityOrigin || f.securityOrigin === '://' || f.securityOrigin === 'null') return true;
  if (f.url.startsWith('data:')) return true;
  // sandbox 无 allow-same-origin
  if (row && row.sandbox !== null && !/\ballow-same-origin\b/.test(row.sandbox)) return true;
  // 3. 父页 iframe.contentDocument 不可达（row 只覆盖顶层 iframe；嵌套帧靠 securityOrigin 兜）
  if (row && !row.sameDoc) return true;
  // 4/5. origin 比不出来或不同 → isolated
  if (!topOrigin || topOrigin === 'null') return true;
  return f.securityOrigin !== topOrigin;
}

export async function listAllFrames(): Promise<FrameInfo[]> {
  const [locals, domRows, oopifs] = await Promise.all([
    localFrames(),
    domIframeRows(),
    oopifUrls(),
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

  // 只在 DOM 行 / getTargets 出现的帧 → isolated 占位（不编 CDP frameId）
  const known = new Set(frames.map((f) => f.url));
  for (const row of domRows) {
    if (row.src && !known.has(row.src)) {
      frames.push({ frameId: `isolated:${row.src}`, parentId: top?.id ?? '', url: row.src, name: row.name, isolated: true });
      known.add(row.src);
    }
  }
  for (const url of oopifs) {
    if (!known.has(url)) {
      frames.push({ frameId: `isolated:${url}`, parentId: top?.id ?? '', url, name: '', isolated: true });
      known.add(url);
    }
  }
  return frames;
}

// ---------- 帧解析 ----------

/** 匹配帧（不含顶层）：先 frameId 精确，再未截断 URL 子串。不抛 isolated。 */
export async function findFrame(value: string): Promise<FrameInfo> {
  const all = (await listAllFrames()).filter((f) => f.parentId !== '' || f.frameId.startsWith('isolated:'));
  const exact = all.filter((f) => f.frameId === value);
  const hits = exact.length > 0 ? exact : all.filter((f) => f.url.includes(value));
  if (hits.length === 0) throw new Error(`iframe: no frame matching "${value}"`);
  if (hits.length > 1) {
    const urls = hits.slice(0, 5).map((f) => f.url).join(', ');
    throw new Error(`iframe: multiple frames match "${value}": ${urls}`);
  }
  return hits[0]!;
}

export async function resolveFrame(value: string): Promise<FrameInfo> {
  const f = await findFrame(value);
  if (f.isolated) throw crossOriginError(f.url);
  return f;
}

export async function frameById(frameId: string): Promise<FrameInfo> {
  const f = (await listAllFrames()).find((x) => x.frameId === frameId);
  if (!f) throw new Error(FRAME_GONE_ERROR);
  return f;
}

export async function isolatedSrcSet(): Promise<Set<string>> {
  const all = await listAllFrames();
  return new Set(all.filter((f) => f.isolated && f.url).map((f) => f.url));
}

// ---------- default-world contextId 表（规格 §ref 表） ----------

const contextByFrame = new Map<string, number>();
const contextWaiters = new Map<string, ((id: number) => void)[]>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || source.tabId !== getAttachedTabId()) return;
  if (method === 'Runtime.executionContextCreated') {
    const ctx = (params as {
      context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
    }).context;
    const frameId = ctx?.auxData?.frameId;
    if (ctx?.id != null && frameId && ctx.auxData?.isDefault) {
      contextByFrame.set(frameId, ctx.id);
      const waiters = contextWaiters.get(frameId) ?? [];
      contextWaiters.delete(frameId);
      for (const w of waiters) w(ctx.id);
    }
  } else if (method === 'Runtime.executionContextsCleared') {
    contextByFrame.clear();
  } else if (method === 'Page.frameNavigated') {
    const frame = (params as { frame?: { parentId?: string } }).frame;
    if (frame && !frame.parentId) {
      // 主文档 commit 导航：ref 表与 context 表作废（协议 §4.1）
      resetRefs();
      clearFrameCaches();
    }
  }
});

chrome.tabs.onRemoved.addListener(() => {
  resetRefs();
  clearFrameCaches();
});

chrome.debugger.onDetach.addListener(() => {
  resetRefs();
  clearFrameCaches();
});

export function clearFrameCaches(): void {
  contextByFrame.clear();
}

/**
 * 该帧 default world 的 executionContextId。MV3 SW 可能丢事件：
 * 缓存未命中时 disable→enable 让 Runtime 重发 executionContextCreated；
 * 再拿不到才退到 Page.createIsolatedWorld（fill/click 看不到页面 JS，仅兜底）。
 */
export async function contextIdForFrame(frameId: string): Promise<number> {
  const cached = contextByFrame.get(frameId);
  if (cached != null) return cached;

  const waiting = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    const list = contextWaiters.get(frameId) ?? [];
    list.push((id) => {
      clearTimeout(timer);
      resolve(id);
    });
    contextWaiters.set(frameId, list);
  });
  await sendCommand('Runtime.disable');
  await sendCommand('Runtime.enable');
  const refreshed = await waiting;
  if (refreshed != null) return refreshed;

  const { executionContextId } = await sendCommand<{ executionContextId: number }>(
    'Page.createIsolatedWorld',
    { frameId, worldName: 'csi-frame', grantUniveralAccess: true },
  );
  return executionContextId;
}
