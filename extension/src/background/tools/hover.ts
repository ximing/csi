/**
 * hover (protocol §4): trusted-path mouseMoved at the element's
 * box-model center — CSS :hover menus without a click. No mousePressed.
 *
 * frame 内元素坐标同样是根视口像素，禁止累加 iframe 盒（DOM.getBoxModel
 * 返回的是根视口 CSS 像素，Input.dispatchMouseEvent 也以根视口为原点）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { isRefSelector } from '../refs';
import { parseFrameArg, resolveObjectId, scrollIntoView } from './element';
import { resolveFrame } from '../frames';

const NO_BOX_ERROR =
  'hover: element has no layout box (display:none / detached / zero-size).';

export class HoverTool implements Tool {
  readonly name = 'hover';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const selector = args.selector as string | undefined;
    if (!selector) throw new Error('hover: selector is required (CSS selector or @e ref)');
    const frameArg = parseFrameArg(this.name, args.frame);
    // @e 忽略 frame（ref 自带帧）；CSS 才解析
    const frameId =
      frameArg && !isRefSelector(selector)
        ? (await resolveFrame(target.tabId, frameArg)).frameId
        : undefined;

    const objectId = await resolveObjectId(this.name, selector, target.tabId, frameId);
    await scrollIntoView(target.tabId, objectId);

    let boxModel: { model?: { content?: number[] } };
    try {
      boxModel = await sendCommand(target.tabId, 'DOM.getBoxModel', { objectId });
    } catch (err) {
      throw new Error(`${NO_BOX_ERROR} (CDP: ${(err as Error).message})`);
    }
    const content = boxModel.model?.content;
    if (!content || content.length < 8) throw new Error(NO_BOX_ERROR);

    const x = (content[0]! + content[2]! + content[4]! + content[6]!) / 4;
    const y = (content[1]! + content[3]! + content[5]! + content[7]!) / 4;

    await sendCommand(target.tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    });

    const info = await sendCommand<{
      result: { value?: { tag?: string; text?: string } };
    }>(target.tabId, 'Runtime.callFunctionOn', {
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
