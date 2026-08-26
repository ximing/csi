/**
 * fill (protocol §4.5): set the value of an input/textarea via the native
 * setter + input/change events (mode:"value"); for contenteditable use a
 * selection + execCommand('insertText'), falling back to textContent +
 * InputEvent (mode:"contenteditable").
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { isRefSelector, lookupRef } from '../refs';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

/** Injected snippet: fills `targetExpr` with `value` and reports the mode. */
function fillSnippet(targetExpr: string, value: string): string {
  const serialized = JSON.stringify(value);
  return `
    const __target = ${targetExpr};
    __target.focus();
    if (__target.isContentEditable) {
      const __sel = window.getSelection();
      if (__sel) {
        const __range = document.createRange();
        __range.selectNodeContents(__target);
        __sel.removeAllRanges();
        __sel.addRange(__range);
      }
      let __inserted = false;
      try {
        __inserted = document.execCommand('insertText', false, ${serialized});
      } catch (_e) {
        __inserted = false;
      }
      if (!__inserted) {
        __target.textContent = ${serialized};
        __target.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: ${serialized},
          bubbles: true,
        }));
      }
      return { success: true, tag: __target.tagName, mode: 'contenteditable' };
    }
    const __nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (__nativeSetter) {
      __nativeSetter.call(__target, ${serialized});
    } else {
      __target.value = ${serialized};
    }
    __target.dispatchEvent(new Event('input', { bubbles: true }));
    __target.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, tag: __target.tagName, mode: 'value' };
  `;
}

export class FillTool implements Tool {
  readonly name = 'fill';

  async execute(args: ToolArgs): Promise<unknown> {
    const selector = args.selector as string | undefined;
    const value = args.value as string | undefined;
    if (!selector) throw new Error('fill: selector is required (CSS selector or @e ref)');
    if (value == null) throw new Error('fill: value is required');
    await ensureAttached((await getCurrentTab()).id!);
    const frameArg = parseFrameArg(this.name, args.frame);
    // @e 忽略 frame（ref 自带帧）；CSS 才解析
    const frameId =
      frameArg && !isRefSelector(selector)
        ? (await resolveFrame(frameArg)).frameId
        : undefined;
    return isRefSelector(selector)
      ? this.fillByRef(selector, value)
      : this.fillBySelector(selector, value, frameId);
  }

  private async fillByRef(selector: string, value: string): Promise<unknown> {
    const entry = lookupRef(selector);
    if (!entry) {
      throw new Error(`fill: unknown ref "${selector}". Run snapshot first to get refs.`);
    }
    const { object } = await sendCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: entry.backendDOMNodeId,
    });
    if (!object?.objectId) {
      throw new Error(`fill: could not resolve ref "${selector}" to DOM element`);
    }
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: unknown };
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { ${fillSnippet('this', value)} }`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`fill: ${result.exceptionDetails.text}`);
    return result.result.value || { success: true };
  }

  private async fillBySelector(selector: string, value: string, frameId?: string): Promise<unknown> {
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: { error?: string } | unknown };
    }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'fill: element not found: ' + ${JSON.stringify(selector)} };
        ${fillSnippet('el', value)}
      })()`,
      returnByValue: true,
      awaitPromise: false,
      ...(frameId ? { contextId: await contextIdForFrame(frameId) } : {}),
    });
    if (result.exceptionDetails) throw new Error(`fill: ${result.exceptionDetails.text}`);
    const ret = result.result.value as { error?: string } | undefined;
    if (ret?.error) throw new Error(ret.error);
    return ret || { success: true };
  }
}
