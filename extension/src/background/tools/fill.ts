/**
 * fill (protocol §4.5): set the value of an input/textarea via the native
 * setter + input/change events (mode:"value"); for contenteditable use a
 * selection + execCommand('insertText'), falling back to textContent +
 * InputEvent (mode:"contenteditable").
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { isRefSelector } from '../refs';
import { parseFrameArg, resolveObjectId } from './element';
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

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const selector = args.selector as string | undefined;
    const value = args.value as string | undefined;
    if (!selector) throw new Error('fill: selector is required (CSS selector or @e ref)');
    if (value == null) throw new Error('fill: value is required');
    const frameArg = parseFrameArg(this.name, args.frame);
    const frameId =
      frameArg && !isRefSelector(selector)
        ? (await resolveFrame(target.tabId, frameArg)).frameId
        : undefined;
    return isRefSelector(selector)
      ? this.fillByRef(target.tabId, selector, value)
      : this.fillBySelector(target.tabId, selector, value, frameId);
  }

  private async fillByRef(tabId: number, selector: string, value: string): Promise<unknown> {
    // 与 element.ts 同一解析路径：死 iframe 的 ref 抛 FRAME_GONE，不漂移成通用 stale_ref。
    const objectId = await resolveObjectId(this.name, selector, tabId);
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: unknown };
    }>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { ${fillSnippet('this', value)} }`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`fill: ${result.exceptionDetails.text}`);
    return result.result.value || { success: true };
  }

  private async fillBySelector(
    tabId: number,
    selector: string,
    value: string,
    frameId?: string,
  ): Promise<unknown> {
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result: { value?: { error?: string } | unknown };
    }>(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'fill: element not found: ' + ${JSON.stringify(selector)} };
        ${fillSnippet('el', value)}
      })()`,
      returnByValue: true,
      awaitPromise: false,
      ...(frameId ? { contextId: await contextIdForFrame(tabId, frameId) } : {}),
    });
    if (result.exceptionDetails) throw new Error(`fill: ${result.exceptionDetails.text}`);
    const ret = result.result.value as { error?: string } | undefined;
    if (ret?.error) throw new Error(ret.error);
    return ret || { success: true };
  }
}
