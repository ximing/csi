/**
 * click (protocol §4.4): DOM-level el.click() on a CSS selector or @eN ref.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { isRefSelector, lookupRef } from '../refs';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

const CLICK_FN = `function() {
  this.scrollIntoView({ block: 'center' });
  this.click();
  return { success: true, tag: this.tagName, text: this.textContent?.slice(0, 100) };
}`;

export class ClickTool implements Tool {
  readonly name = 'click';

  async execute(args: ToolArgs): Promise<unknown> {
    const selector = args.selector as string | undefined;
    if (!selector) throw new Error('click: selector is required (CSS selector or @e ref)');
    await ensureAttached((await getCurrentTab()).id!);
    const frameArg = parseFrameArg(this.name, args.frame);
    // @e 忽略 frame（ref 自带帧）；CSS 才解析
    const frameId =
      frameArg && !isRefSelector(selector)
        ? (await resolveFrame(frameArg)).frameId
        : undefined;
    return isRefSelector(selector)
      ? this.clickByRef(selector)
      : this.clickBySelector(selector, frameId);
  }

  private async clickByRef(selector: string): Promise<unknown> {
    const entry = lookupRef(selector);
    if (!entry) {
      throw new Error(`click: unknown ref "${selector}". Run snapshot first to get refs.`);
    }
    const { object } = await sendCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: entry.backendDOMNodeId,
    });
    if (!object?.objectId) {
      throw new Error(`click: could not resolve ref "${selector}" to DOM element`);
    }
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: unknown };
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: CLICK_FN,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
    return result.result.value || { success: true };
  }

  private async clickBySelector(selector: string, frameId?: string): Promise<unknown> {
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: { error?: string } | unknown };
    }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'click: element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { success: true, tag: el.tagName, text: el.textContent?.slice(0, 100) };
      })()`,
      returnByValue: true,
      awaitPromise: false,
      ...(frameId ? { contextId: await contextIdForFrame(frameId) } : {}),
    });
    if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
    const value = result.result.value as { error?: string } | undefined;
    if (value?.error) throw new Error(value.error);
    return value || { success: true };
  }
}
