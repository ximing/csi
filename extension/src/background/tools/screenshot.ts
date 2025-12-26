/**
 * screenshot (protocol §4.12): Page.captureScreenshot, optionally clipped to
 * an element's border box. The base64 payload goes back to the daemon,
 * which writes it to disk (protocol §5).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { resolveObjectId, scrollIntoView } from './element';

const NO_BOX_ERROR =
  'screenshot: element has no layout box (display:none / detached / zero-size).';

interface CaptureParams {
  format: string;
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale: number };
}

export class ScreenshotTool implements Tool {
  readonly name = 'screenshot';

  async execute(args: ToolArgs): Promise<unknown> {
    await ensureAttached((await getCurrentTab()).id!);

    const format = (args.format as string | undefined) || 'png';
    const quality = format === 'jpeg' ? ((args.quality as number | undefined) || 80) : undefined;
    const selector = typeof args.selector === 'string' ? args.selector : '';

    const params: CaptureParams = { format };
    if (quality !== undefined) params.quality = quality;

    if (selector) {
      const objectId = await resolveObjectId(this.name, selector);
      await scrollIntoView(objectId);

      let boxModel: { model?: { border?: number[] } };
      try {
        boxModel = await sendCommand('DOM.getBoxModel', { objectId });
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
    }

    const shot = await sendCommand<{ data: string }>('Page.captureScreenshot', params);
    return { format, dataLength: shot.data.length, data: shot.data };
  }
}
