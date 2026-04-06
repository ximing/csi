/**
 * Shared helpers for tools that resolve a `selector` (CSS or @eN ref) to a
 * CDP RemoteObject, and for scrolling elements into view.
 */
import { sendCommand } from '../debugger-session';
import { isRefSelector, lookupRef } from '../refs';
import { contextIdForFrame, FRAME_GONE_ERROR } from '../frames';

/**
 * Resolve a selector to a CDP objectId. `toolName` prefixes error messages
 * so failures read e.g. "mouse_click: unknown ref ...".
 *
 * `frameId` (协议 §4.1)：CSS 路径有 frameId 时进该帧 default world；
 * ref 路径不带 contextId（Blink 按 node 所在 LocalFrame 的 main world 解析），
 * 但 ref 解析失败且 ref 带 frameId 时报帧没了。
 */
export async function resolveObjectId(
  toolName: string,
  selector: string,
  frameId?: string,
): Promise<string> {
  return isRefSelector(selector)
    ? objectIdFromRef(toolName, selector)
    : objectIdFromCss(toolName, selector, frameId);
}

/** 解析可选 frame 参数：null/缺省/空字符串 = 未传；非字符串真值报错（协议 §3.3）。 */
export function parseFrameArg(toolName: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${toolName}: frame must be a string (frameId or URL substring)`);
  }
  return raw;
}

async function objectIdFromRef(toolName: string, selector: string): Promise<string> {
  const entry = lookupRef(selector);
  if (!entry) {
    throw new Error(`${toolName}: unknown ref "${selector}". Run snapshot first to get refs.`);
  }
  const { object } = await sendCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  });
  if (!object?.objectId) {
    if (entry.frameId) throw new Error(FRAME_GONE_ERROR);
    throw new Error(`${toolName}: could not resolve ref "${selector}" to DOM element`);
  }
  return object.objectId;
}

async function objectIdFromCss(
  toolName: string,
  selector: string,
  frameId?: string,
): Promise<string> {
  const params: Record<string, unknown> = {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  };
  if (frameId) params.contextId = await contextIdForFrame(frameId);
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result: { subtype?: string; objectId?: string };
  }>('Runtime.evaluate', params);
  if (result.exceptionDetails) {
    throw new Error(`${toolName}: ${result.exceptionDetails.text}`);
  }
  if (result.result.subtype === 'null' || !result.result.objectId) {
    throw new Error(`${toolName}: element not found: ${selector}`);
  }
  return result.result.objectId;
}

export async function scrollIntoView(objectId: string): Promise<void> {
  await sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`,
  });
}
