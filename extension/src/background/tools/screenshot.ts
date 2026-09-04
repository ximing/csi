/**
 * screenshot (protocol §4): Page.captureScreenshot, optionally clipped to
 * an element's border box or captured beyond the viewport (fullPage). The
 * base64 payload goes back to the daemon, which writes it to disk (protocol §5).
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { isRefSelector } from '../refs';
import { parseFrameArg, resolveObjectId, scrollIntoView } from './element';
import { resolveFrame, FRAME_GONE_ERROR } from '../frames';

const NO_BOX_ERROR =
  'screenshot: element has no layout box (display:none / detached / zero-size).';

interface CaptureParams {
  format: string;
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale: number };
}

export class ScreenshotTool implements Tool {
  readonly name = 'screenshot';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const format = (args.format as string | undefined) || 'png';
    const quality = format === 'jpeg' ? ((args.quality as number | undefined) || 80) : undefined;
    const selector = typeof args.selector === 'string' ? args.selector : '';
    const fullPage = args.fullPage === true;
    if (fullPage && selector) {
      throw new Error('screenshot: fullPage and selector are mutually exclusive');
    }

    const frameArg = parseFrameArg(this.name, args.frame);
    // @e 忽略 frame（ref 自带帧）；CSS 才解析
    const frameId =
      frameArg && selector && !isRefSelector(selector)
        ? (await resolveFrame(target.tabId, frameArg)).frameId
        : undefined;

    let shot: { data: string };
    if (selector) {
      const params: CaptureParams = { format };
      if (quality !== undefined) params.quality = quality;

      const objectId = await resolveObjectId(this.name, selector, target.tabId, frameId);
      await scrollIntoView(target.tabId, objectId);

      let boxModel: { model?: { border?: number[] } };
      try {
        boxModel = await sendCommand(target.tabId, 'DOM.getBoxModel', { objectId });
      } catch (err) {
        throw new Error(`${NO_BOX_ERROR} (CDP: ${(err as Error).message})`);
      }
      const border = boxModel.model?.border;
      if (!border || border.length < 8) throw new Error(NO_BOX_ERROR);

      const xs = [border[0]!, border[2]!, border[4]!, border[6]!];
      const ys = [border[1]!, border[3]!, border[5]!, border[7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width <= 0 || height <= 0) {
        throw new Error(`screenshot: element has zero-size box (width=${width}, height=${height}).`);
      }
      params.clip = { x, y, width, height, scale: 1 };
      shot = await sendCommand<{ data: string }>(target.tabId, 'Page.captureScreenshot', params);
    } else if (fullPage && frameArg) {
      // fullPage + frame（无 selector）：clip 到该 iframe 元素在父页视口里的可见盒，
      // 不开 captureBeyondViewport（协议 §4.1）。
      const frameId = (await resolveFrame(target.tabId, frameArg)).frameId;
      const { backendNodeId } = await sendCommand<{ backendNodeId: number }>(target.tabId, 
        'DOM.getFrameOwner',
        { frameId },
      );
      const { object } = await sendCommand<{ object?: { objectId?: string } }>(target.tabId, 
        'DOM.resolveNode',
        { backendNodeId },
      );
      if (!object?.objectId) throw new Error(FRAME_GONE_ERROR);

      const params: CaptureParams = { format };
      if (quality !== undefined) params.quality = quality;

      let boxModel: { model?: { border?: number[] } };
      try {
        boxModel = await sendCommand(target.tabId, 'DOM.getBoxModel', { objectId: object.objectId });
      } catch (err) {
        throw new Error(`${NO_BOX_ERROR} (CDP: ${(err as Error).message})`);
      }
      const border = boxModel.model?.border;
      if (!border || border.length < 8) throw new Error(NO_BOX_ERROR);

      const xs = [border[0]!, border[2]!, border[4]!, border[6]!];
      const ys = [border[1]!, border[3]!, border[5]!, border[7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width <= 0 || height <= 0) {
        throw new Error(`screenshot: element has zero-size box (width=${width}, height=${height}).`);
      }
      params.clip = { x, y, width, height, scale: 1 };
      shot = await sendCommand<{ data: string }>(target.tabId, 'Page.captureScreenshot', params);
    } else {
      const params: CaptureParams & { captureBeyondViewport?: boolean } = { format };
      if (quality !== undefined) params.quality = quality;
      if (fullPage) params.captureBeyondViewport = true;
      try {
        shot = await sendCommand<{ data: string }>(target.tabId, 'Page.captureScreenshot', params);
      } catch (err) {
        if (fullPage) {
          throw new Error(
            `screenshot: fullPage failed (${(err as Error).message}); try selector or a smaller viewport`,
          );
        }
        throw err;
      }
    }
    return { format, dataLength: shot.data.length, data: shot.data };
  }
}
