/**
 * mouse_click (protocol §4.8): trusted-path clicking via
 * Input.dispatchMouseEvent at the element's box-model center — passes
 * isTrusted checks that DOM-level click() cannot.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { resolveObjectId, scrollIntoView } from './element';

const NO_BOX_ERROR =
  "mouse_click: element has no layout box (display:none / detached / zero-size). Use 'click' for DOM-level fallback.";

export class MouseClickTool implements Tool {
  readonly name = 'mouse_click';

  async execute(args: ToolArgs): Promise<unknown> {
    const selector = args.selector as string | undefined;
    if (!selector) throw new Error('mouse_click: selector is required (CSS selector or @e ref)');
    await ensureAttached((await getCurrentTab()).id!);

    const objectId = await resolveObjectId(this.name, selector);
    await scrollIntoView(objectId);

    let boxModel: { model?: { content?: number[] } };
    try {
      boxModel = await sendCommand('DOM.getBoxModel', { objectId });
    } catch (err) {
      throw new Error(`${NO_BOX_ERROR} (CDP: ${(err as Error).message})`);
    }
    const content = boxModel.model?.content;
    if (!content || content.length < 8) throw new Error(NO_BOX_ERROR);

    const x = (content[0]! + content[2]! + content[4]! + content[6]!) / 4;
    const y = (content[1]! + content[3]! + content[5]! + content[7]!) / 4;

    await sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    });
    await sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

    const info = await sendCommand<{
      result: { value?: { tag?: string; text?: string } };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { return { tag: this.tagName, text: (this.textContent || '').slice(0, 100) }; }`,
      returnByValue: true,
    });

    return {
      success: true,
      x: Math.round(x),
      y: Math.round(y),
      tag: info.result.value?.tag ?? '',
      text: info.result.value?.text ?? '',
    };
  }
}
