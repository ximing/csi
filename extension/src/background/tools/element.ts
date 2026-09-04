/**
 * Shared helpers for tools that resolve a `selector` (CSS or @eN ref) to a
 * CDP RemoteObject, and for scrolling elements into view.
 */
import { sendCommand } from '../debugger-session';
import { consumeRef, isRefSelector, staleRefError, type RefEntry } from '../refs';
import { contextIdForFrame, FRAME_GONE_ERROR } from '../frames';

export interface ResolvedRefNode {
  objectId?: string;
  entry: RefEntry;
}

/**
 * consumeRef（unknown_ref/stale_ref 照旧抛 ToolError）+ DOM.resolveNode。
 * 节点已不在文档中（同文档移除、帧已卸载）时不抛，objectId 为空，语义由调用方定。
 */
export async function resolveRefNode(
  toolName: string,
  selector: string,
  tabId: number,
): Promise<ResolvedRefNode> {
  const entry = consumeRef(tabId, toolName, selector);
  // 真实 Chrome 对死 backendNodeId（跨文档导航后的旧节点）resolveNode 是
  // reject（"No node with given backend id"），不是返回空 object——只有这种
  // 「节点不在文档」的 rejection 才归为空 objectId（语义由调用方定）。
  // 其余 rejection（debugger 被断开、renderer 崩溃）必须上抛：吞掉会让
  // click/fill 误报 stale_ref 引导重拍（治标不治本），wait gone:true 假命中
  // （元素其实还在页面上）。tab 本身已死的 rejection 也不能吞：探测一下，
  // tab 没了就把 raw 错上抛，交给出口归 stale_target。
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  }).catch(async (err): Promise<{ object?: { objectId?: string } }> => {
    await chrome.tabs.get(tabId); // tab 已死则这里抛 raw 错，交给出口归 stale_target
    if (err instanceof Error && /no node with given/i.test(err.message)) return {};
    throw err;
  });
  return { objectId: resolved.object?.objectId, entry };
}

export async function resolveObjectId(
  toolName: string,
  selector: string,
  tabId: number,
  frameId?: string,
): Promise<string> {
  return isRefSelector(selector)
    ? objectIdFromRef(toolName, selector, tabId)
    : objectIdFromCss(toolName, selector, tabId, frameId);
}

export function parseFrameArg(toolName: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${toolName}: frame must be a string (frameId or URL substring)`);
  }
  return raw;
}

async function objectIdFromRef(toolName: string, selector: string, tabId: number): Promise<string> {
  const { objectId, entry } = await resolveRefNode(toolName, selector, tabId);
  if (!objectId) {
    if (entry.frameId) throw new Error(FRAME_GONE_ERROR);
    throw staleRefError(toolName, selector, tabId);
  }
  return objectId;
}

async function objectIdFromCss(
  toolName: string,
  selector: string,
  tabId: number,
  frameId?: string,
): Promise<string> {
  const params: Record<string, unknown> = {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  };
  if (frameId) params.contextId = await contextIdForFrame(tabId, frameId);
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result: { subtype?: string; objectId?: string };
  }>(tabId, 'Runtime.evaluate', params);
  if (result.exceptionDetails) {
    throw new Error(`${toolName}: ${result.exceptionDetails.text}`);
  }
  if (result.result.subtype === 'null' || !result.result.objectId) {
    throw new Error(`${toolName}: element not found: ${selector}`);
  }
  return result.result.objectId;
}

export async function scrollIntoView(tabId: number, objectId: string): Promise<void> {
  await sendCommand(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`,
  });
}
