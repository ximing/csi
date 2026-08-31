/**
 * click (protocol §4.4): DOM-level el.click() on a CSS selector or @eN ref.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { consumeRef, isRefSelector, staleRefError } from '../refs';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

const CLICK_FN = `function() {
  this.scrollIntoView({ block: 'center' });
  this.click();
  return { success: true, tag: this.tagName, text: this.textContent?.slice(0, 100) };
}`;

export class ClickTool implements Tool {
  readonly name = 'click';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const selector = args.selector as string | undefined;
    if (!selector) throw new Error('click: selector is required (CSS selector or @e ref)');
    const frameArg = parseFrameArg(this.name, args.frame);
    const frameId =
      frameArg && !isRefSelector(selector)
        ? (await resolveFrame(target.tabId, frameArg)).frameId
        : undefined;
    return isRefSelector(selector)
      ? this.clickByRef(target.tabId, selector)
      : this.clickBySelector(target.tabId, selector, frameId);
  }

  private async clickByRef(tabId: number, selector: string): Promise<unknown> {
    const entry = consumeRef(tabId, 'click', selector);
    const { object } = await sendCommand<{ object?: { objectId?: string } }>(
      tabId,
      'DOM.resolveNode',
      { backendNodeId: entry.backendDOMNodeId },
    );
    if (!object?.objectId) {
      throw staleRefError('click', selector, tabId);
    }
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: unknown };
    }>(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: CLICK_FN,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
    return result.result.value || { success: true };
  }

  private async clickBySelector(
    tabId: number,
    selector: string,
    frameId?: string,
  ): Promise<unknown> {
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: { error?: string } | unknown };
    }>(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'click: element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { success: true, tag: el.tagName, text: el.textContent?.slice(0, 100) };
      })()`,
      returnByValue: true,
      awaitPromise: false,
      ...(frameId ? { contextId: await contextIdForFrame(tabId, frameId) } : {}),
    });
    if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
    const value = result.result.value as { error?: string } | undefined;
    if (value?.error) throw new Error(value.error);
    return value || { success: true };
  }
}
