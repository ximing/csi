/**
 * wait (protocol §4): poll in the extension until text / selector / url
 * matches (or is gone). One condition only; unknown @e fails immediately.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { consumeRef, isRefSelector } from '../refs';
import { ToolError } from '../tool-error';
import { parseFrameArg, resolveRefNode } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

type WaitKind = 'text' | 'selector' | 'url';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 200;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2_000;

export class WaitTool implements Tool {
  readonly name = 'wait';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
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

    const currentId = target.tabId;
    // 未知/过期 @e 立刻失败，带 code 的 ToolError（unknown_ref/stale_ref），
    // 与 click/snapshot 等工具的错误契约一致（协议 §3.3、§4 wait「@e 不在 ref 表则立刻失败」）。
    if (picked.kind === 'selector' && isRefSelector(picked.value)) {
      consumeRef(currentId, this.name, picked.value);
    }

    // frameArg 在进循环之前解析成 frameId（resolveFrame 的错误要立刻抛，不能被轮询吃掉）。
    // @e 忽略 frame（ref 自带帧）；url 不看 frame（仍看 tab URL，协议 §4.1）。
    const frameArg = parseFrameArg(this.name, args.frame);
    const isRefSel = picked.kind === 'selector' && isRefSelector(picked.value);
    const frameId =
      frameArg && picked.kind !== 'url' && !isRefSel
        ? (await resolveFrame(target.tabId, frameArg)).frameId
        : undefined;

    const kindLabel = gone ? `gone:${picked.kind}` : picked.kind;
    const matched = `${kindLabel}:${picked.value}`;

    const start = Date.now();
    const deadline = start + timeout;
    while (true) {
      const hit = await this.check(picked.kind, picked.value, currentId, frameId);
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

  private async check(
    kind: WaitKind,
    value: string,
    currentId: number,
    frameId?: string,
  ): Promise<boolean> {
    try {
      if (kind === 'url') return await checkUrl(currentId, value);
      if (kind === 'text') return await checkText(currentId, value, frameId);
      return await checkSelector(currentId, value, frameId);
    } catch (err) {
      // ToolError（轮询中途导航导致的 stale_ref 等）是确定性失败，原样上抛，
      // 不能吞成超时；其余错误按导航途中的瞬时不可用处理，视为未命中继续轮询。
      if (err instanceof ToolError) throw err;
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

async function checkText(tabId: number, needle: string, frameId?: string): Promise<boolean> {
  const params: Record<string, unknown> = {
    expression: `document.body && document.body.innerText.includes(${JSON.stringify(needle)})`,
    returnByValue: true,
  };
  if (frameId) params.contextId = await contextIdForFrame(tabId, frameId);
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result?: { value?: unknown };
  }>(tabId, 'Runtime.evaluate', params);
  if (!result.exceptionDetails && result.result?.value === true) return true;

  const { nodes } = await sendCommand<{ nodes?: { name?: { value?: unknown } }[] }>(
    tabId,
    'Accessibility.getFullAXTree',
    frameId ? { frameId } : undefined,
  );
  return (nodes ?? []).some(
    (node) => typeof node.name?.value === 'string' && node.name.value.includes(needle),
  );
}

async function checkSelector(tabId: number, selector: string, frameId?: string): Promise<boolean> {
  let objectId: string | undefined;
  if (isRefSelector(selector)) {
    // consumeRef 的 unknown_ref/stale_ref 是确定性失败（ToolError 经 check 原样透出）；
    // 节点已从文档移除只是未命中（gone:true 下即命中成功），不能上抛成 stale_ref。
    const resolved = await resolveRefNode('wait', selector, tabId);
    if (!resolved.objectId) return false;
    objectId = resolved.objectId;
  } else {
    const params: Record<string, unknown> = {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    };
    if (frameId) params.contextId = await contextIdForFrame(tabId, frameId);
    const result = await sendCommand<{
      exceptionDetails?: { text: string };
      result?: { subtype?: string; objectId?: string };
    }>(tabId, 'Runtime.evaluate', params);
    if (result.exceptionDetails || result.result?.subtype === 'null' || !result.result?.objectId) {
      return false;
    }
    objectId = result.result.objectId;
  }

  let boxModel: { model?: { border?: number[]; content?: number[] } };
  try {
    boxModel = await sendCommand(tabId, 'DOM.getBoxModel', { objectId });
  } catch {
    return false;
  }
  if (!hasPositiveBox(boxModel.model?.border) && !hasPositiveBox(boxModel.model?.content)) {
    return false;
  }

  const hidden = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
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
