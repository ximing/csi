/**
 * scroll (protocol §4.10): exactly one of selector / to / direction.
 * selector uses the shared scrollIntoView helper; to/direction touch
 * window via Runtime.evaluate. Always returns window scroll position.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { resolveObjectId, scrollIntoView } from './element';

const SCROLL_POS_JS = `({
  x: window.scrollX,
  y: window.scrollY,
  maxX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  maxY: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
})`;

type ScrollPos = { success: true; x: number; y: number; maxX: number; maxY: number };

export class ScrollTool implements Tool {
  readonly name = 'scroll';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const hasSel = typeof args.selector === 'string' && args.selector.length > 0;
    const to = args.to as string | undefined;
    const dir = args.direction as string | undefined;
    const n = Number(hasSel) + Number(!!to) + Number(!!dir);
    if (n !== 1) throw new Error('scroll: specify exactly one of selector, to, direction');

    if (to && to !== 'top' && to !== 'bottom') {
      throw new Error('scroll: to must be top or bottom');
    }
    if (dir && dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
      throw new Error('scroll: direction must be up, down, left, or right');
    }
    const amount = dir ? parseAmount(args.amount) : undefined;

    if (hasSel) {
      const objectId = await resolveObjectId(this.name, args.selector as string, target.tabId);
      await scrollIntoView(target.tabId, objectId);
      return evaluateScroll(target.tabId, SCROLL_POS_JS);
    }

    if (to === 'top') {
      return evaluateScroll(target.tabId, `(() => { window.scrollTo(0, 0); return ${SCROLL_POS_JS}; })()`);
    }
    if (to === 'bottom') {
      return evaluateScroll(
        target.tabId,
        `(() => { window.scrollTo(0, document.documentElement.scrollHeight); return ${SCROLL_POS_JS}; })()`,
      );
    }

    return evaluateScroll(
      target.tabId,
      `(() => { ${directionAction(dir!, amount!)}; return ${SCROLL_POS_JS}; })()`,
    );
  }
}

function parseAmount(raw: unknown): number | 'page' {
  if (raw === undefined || raw === null) return 'page';
  if (raw === 'page') return 'page';
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  throw new Error('scroll: amount must be a number or "page"');
}

function directionAction(dir: string, amount: number | 'page'): string {
  const vertical = dir === 'up' || dir === 'down';
  const negative = dir === 'up' || dir === 'left';
  const delta =
    amount === 'page'
      ? `0.9 * window.${vertical ? 'innerHeight' : 'innerWidth'}`
      : `(${JSON.stringify(amount)})`;
  const signed = negative ? `-(${delta})` : delta;
  return vertical ? `window.scrollBy(0, ${signed})` : `window.scrollBy(${signed}, 0)`;
}

async function evaluateScroll(tabId: number, expression: string): Promise<ScrollPos> {
  const result = await sendCommand<{
    exceptionDetails?: { text: string; exception?: { description?: string } };
    result?: { value?: { x?: number; y?: number; maxX?: number; maxY?: number } };
  }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`scroll: ${description}`);
  }
  const v = result.result?.value;
  if (
    !v ||
    typeof v.x !== 'number' ||
    typeof v.y !== 'number' ||
    typeof v.maxX !== 'number' ||
    typeof v.maxY !== 'number'
  ) {
    throw new Error('scroll: failed to read window scroll position');
  }
  return {
    success: true,
    x: Math.round(v.x),
    y: Math.round(v.y),
    maxX: Math.round(v.maxX),
    maxY: Math.round(v.maxY),
  };
}
