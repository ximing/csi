/**
 * screenshot (protocol §4 / §4.6): Page.captureScreenshot, optionally clipped
 * to an element's border box or captured beyond the viewport (fullPage).
 * Default encoding is webp (quality 80) so the WS payload and the file the
 * agent reads stay small; png/jpeg remain explicit. The base64 payload goes
 * back to the daemon, which writes it to disk without re-encoding (protocol §5).
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { isRefSelector } from '../refs';
import { parseFrameArg, resolveObjectId, scrollIntoView } from './element';
import { resolveFrame, FRAME_GONE_ERROR } from '../frames';

const NO_BOX_ERROR =
  'screenshot: element has no layout box (display:none / detached / zero-size).';

const SCREENSHOT_FORMATS = new Set(['png', 'jpeg', 'webp']);

interface CaptureParams {
  format: string;
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale: number };
}

/** 协议 §4.6：显式 format 优先；否则按 path 扩展名推断；再否则 webp。 */
function resolveScreenshotFormat(args: ToolArgs): string {
  const explicit = args.format;
  if (typeof explicit === 'string' && explicit !== '') {
    if (!SCREENSHOT_FORMATS.has(explicit)) {
      throw new Error('screenshot: format must be png, jpeg, or webp');
    }
    return explicit;
  }
  const path = typeof args.path === 'string' ? args.path : '';
  return formatFromPath(path) ?? 'webp';
}

function formatFromPath(path: string): string | undefined {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return undefined;
  switch (m[1]) {
    case 'png':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpeg';
    case 'webp':
      return 'webp';
    default:
      return undefined;
  }
}

/** webp/jpeg 默认 quality 80；png 忽略。 */
function resolveQuality(format: string, raw: unknown): number | undefined {
  if (format !== 'jpeg' && format !== 'webp') return undefined;
  if (raw === undefined || raw === null) return 80;
  return raw as number;
}

function captureBase(format: string, quality: number | undefined): CaptureParams {
  const params: CaptureParams = { format };
  if (quality !== undefined) params.quality = quality;
  return params;
}

export class ScreenshotTool implements Tool {
  readonly name = 'screenshot';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const format = resolveScreenshotFormat(args);
    const quality = resolveQuality(format, args.quality);
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
      const params = captureBase(format, quality);

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

      const params = captureBase(format, quality);

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
      const params: CaptureParams & { captureBeyondViewport?: boolean } = captureBase(
        format,
        quality,
      );
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
