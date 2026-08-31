/**
 * Shared helpers for tools that resolve a `selector` (CSS or @eN ref) to a
 * CDP RemoteObject, and for scrolling elements into view.
 */
import { sendCommand } from '../debugger-session';
import { consumeRef, isRefSelector, staleRefError } from '../refs';
import { contextIdForFrame, FRAME_GONE_ERROR } from '../frames';

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
  const entry = consumeRef(tabId, toolName, selector);
  const { object } = await sendCommand<{ object?: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  });
  if (!object?.objectId) {
    if (entry.frameId) throw new Error(FRAME_GONE_ERROR);
    throw staleRefError(toolName, selector, tabId);
  }
  return object.objectId;
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
