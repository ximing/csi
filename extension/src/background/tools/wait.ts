/**
 * wait (protocol §4): poll in the extension until text / selector / url
 * matches (or is gone). One condition only; unknown @e fails immediately.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { isRefSelector, lookupRef } from '../refs';
import { resolveObjectId } from './element';

type WaitKind = 'text' | 'selector' | 'url';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 200;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2_000;

export class WaitTool implements Tool {
  readonly name = 'wait';

  async execute(args: ToolArgs): Promise<unknown> {
    const picked = pickCondition(args);
    const gone = args.gone === true;
    const timeout = parseIntRange(
      args.timeout_ms,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeout_ms',
    );
    const interval = parseIntRange(
      args.interval_ms,
      DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
      MAX_INTERVAL_MS,
      'interval_ms',
    );

    if (picked.kind === 'selector' && isRefSelector(picked.value) && !lookupRef(picked.value)) {
      throw new Error(
        `wait: unknown ref "${picked.value}". Run snapshot first, or wait on a CSS selector / text instead.`,
      );
    }

    const tab = await getCurrentTab();
    const currentId = tab.id!;
    await ensureAttached(currentId);

    const kindLabel = gone ? `gone:${picked.kind}` : picked.kind;
    const matched = `${kindLabel}:${picked.value}`;

    const start = Date.now();
    const deadline = start + timeout;
    while (true) {
      const hit = await this.check(picked.kind, picked.value, currentId);
      if (gone ? !hit : hit) {
        return { success: true, waitedMs: Date.now() - start, matched };
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, interval));
    }

    let lastUrl = '';
    try {
      lastUrl = (await chrome.tabs.get(currentId)).url ?? '';
    } catch {
      lastUrl = '';
    }
    throw new Error(
      `wait: timed out after ${timeout}ms waiting for ${kindLabel} "${picked.value}" (last url: ${lastUrl})`,
    );
  }

  private async check(kind: WaitKind, value: string, currentId: number): Promise<boolean> {
    try {
      if (kind === 'url') return await checkUrl(currentId, value);
      if (kind === 'text') return await checkText(value);
      return await checkSelector(value);
    } catch {
      return false;
    }
  }
}

function pickCondition(args: ToolArgs): { kind: WaitKind; value: string } {
  const candidates: { kind: WaitKind; value: unknown }[] = [
    { kind: 'text', value: args.text },
    { kind: 'selector', value: args.selector },
    { kind: 'url', value: args.url },
  ];
  const nonempty = candidates.filter(
    (c): c is { kind: WaitKind; value: string } => typeof c.value === 'string' && c.value.length > 0,
  );
  if (nonempty.length !== 1) {
    throw new Error('wait: specify exactly one of text, selector, url');
  }
  return nonempty[0]!;
}

function parseIntRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`wait: ${name} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

async function checkUrl(currentId: number, needle: string): Promise<boolean> {
  const tab = await chrome.tabs.get(currentId);
  return (tab.url ?? '').includes(needle);
}

async function checkText(needle: string): Promise<boolean> {
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result?: { value?: unknown };
  }>('Runtime.evaluate', {
    expression: `document.body && document.body.innerText.includes(${JSON.stringify(needle)})`,
    returnByValue: true,
  });
  if (!result.exceptionDetails && result.result?.value === true) return true;

  const { nodes } = await sendCommand<{ nodes?: { name?: { value?: unknown } }[] }>(
    'Accessibility.getFullAXTree',
  );
  return (nodes ?? []).some(
    (node) => typeof node.name?.value === 'string' && node.name.value.includes(needle),
  );
}

async function checkSelector(selector: string): Promise<boolean> {
  let objectId: string | undefined;
  if (isRefSelector(selector)) {
    try {
      objectId = await resolveObjectId('wait', selector);
    } catch {
      return false;
    }
  } else {
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result?: { subtype?: string; objectId?: string };
    }>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });
    if (result.exceptionDetails || result.result?.subtype === 'null' || !result.result?.objectId) {
      return false;
    }
    objectId = result.result.objectId;
  }

  let boxModel: { model?: { border?: number[]; content?: number[] } };
  try {
    boxModel = await sendCommand('DOM.getBoxModel', { objectId });
  } catch {
    return false;
  }
  if (!hasPositiveBox(boxModel.model?.border) && !hasPositiveBox(boxModel.model?.content)) {
    return false;
  }

  const hidden = await sendCommand<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { return this.getAttribute('aria-hidden') === 'true'; }`,
    returnByValue: true,
  });
  return hidden.result?.value !== true;
}

function hasPositiveBox(quad?: number[]): boolean {
  if (!quad || quad.length < 8) return false;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width > 0 && height > 0;
}
