/**
 * Shared helpers for tools that resolve a `selector` (CSS or @eN ref) to a
 * CDP RemoteObject, and for scrolling elements into view.
 */
import { sendCommand } from '../debugger-session';
import { isRefSelector, lookupRef } from '../refs';

/**
 * Resolve a selector to a CDP objectId. `toolName` prefixes error messages
 * so failures read e.g. "mouse_click: unknown ref ...".
 */
export async function resolveObjectId(toolName: string, selector: string): Promise<string> {
  return isRefSelector(selector)
    ? objectIdFromRef(toolName, selector)
    : objectIdFromCss(toolName, selector);
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
    throw new Error(`${toolName}: could not resolve ref "${selector}" to DOM element`);
  }
  return object.objectId;
}

async function objectIdFromCss(toolName: string, selector: string): Promise<string> {
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result: { subtype?: string; objectId?: string };
  }>('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
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
