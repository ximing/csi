/**
 * snapshot (protocol §4): dump the accessibility tree of the current tab
 * via Accessibility.getFullAXTree. Default `mode=compact` returns YAML
 * produced in this process (ax-yaml.ts) before the WS payload; `full`
 * keeps the JSON array. none/generic wrappers are collapsed; interactive
 * roles get an `@eN` ref (backendDOMNodeId mapping, see refs.ts).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { assignRef, INTERACTIVE_ROLES, resetRefs } from '../refs';
import { resolveObjectId, parseFrameArg } from './element';
import { compactFromAx, renderYaml, type AxNode } from './ax-yaml';
import {
  resolveFrame,
  frameById,
  crossOriginError,
  isolatedSrcSet,
  contextIdForFrame,
  FRAME_GONE_ERROR,
  type FrameInfo,
} from '../frames';

export interface SnapshotNode {
  role: string;
  name?: unknown;
  value?: unknown;
  description?: unknown;
  ref?: string;
  children?: SnapshotNode[];
}

const SNAPSHOT_MODES = new Set(['compact', 'interactive', 'full']);
const DEFAULT_MAX_CHARS = 24_000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 80_000;

export class SnapshotTool implements Tool {
  readonly name = 'snapshot';

  async execute(args: ToolArgs): Promise<unknown> {
    const mode = parseMode(args.mode);
    const maxChars = parseMaxChars(args.max_chars);
    const selector =
      typeof args.selector === 'string' && args.selector.length > 0
        ? args.selector
        : undefined;
    const frameArg = parseFrameArg(this.name, args.frame);

    const tab = await getCurrentTab();
    await ensureAttached(tab.id!);

    // frame= 先解析（0 命中/多命中/跨域错误在这里抛，协议 §4.1）。
    // @e 的 selector 忽略它（ref 表自带 frameId），CSS 的 selector 在该帧里找。
    let preFrame: FrameInfo | undefined;
    if (frameArg) preFrame = await resolveFrame(frameArg);

    // selector 在 resetRefs 之前解析，旧快照的 @e 仍可用。
    let backendNodeId: number | undefined;
    let targetFrame: FrameInfo | undefined;
    if (selector) {
      const objectId = await resolveObjectId('snapshot', selector, preFrame?.frameId);
      const described = await sendCommand<{
        node?: { backendNodeId?: number; nodeName?: string; frameId?: string };
      }>('DOM.describeNode', { objectId });
      const node = described.node;
      const nodeName = (node?.nodeName ?? '').toUpperCase();
      if (nodeName === 'IFRAME' || nodeName === 'FRAME') {
        // 入口 1：selector 指向 iframe/frame → 拍它的子帧
        if (!node?.frameId) throw new Error(FRAME_GONE_ERROR);
        targetFrame = await frameById(node.frameId);
        if (preFrame && preFrame.frameId !== targetFrame.frameId) {
          throw new Error('iframe: selector and frame do not refer to the same frame');
        }
        if (targetFrame.isolated) throw crossOriginError(targetFrame.url);
      } else {
        backendNodeId = node?.backendNodeId;
        if (backendNodeId == null) {
          throw new Error(`snapshot: element not found: ${selector}`);
        }
        targetFrame = preFrame; // 帧内子树（协议 §4.1）
      }
    } else if (preFrame) {
      targetFrame = preFrame; // 入口 2：frame= 直接进
    }

    const isFrameEntry = targetFrame != null && backendNodeId == null;
    if (!isFrameEntry) resetRefs(); // 整页与普通子树 reset；进帧 snapshot 追加（协议 §4.1）

    const axParams = targetFrame ? { frameId: targetFrame.frameId } : undefined;
    let nodes: AxNode[];
    try {
      ({ nodes } = await sendCommand<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', axParams));
    } catch (err) {
      if (targetFrame?.isolated) throw crossOriginError(targetFrame.url);
      if (targetFrame) throw new Error(FRAME_GONE_ERROR);
      throw err;
    }
    const isolatedSrcs = await isolatedSrcSet();

    let subtreeRoot: AxNode | undefined;
    if (selector) {
      subtreeRoot = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
      if (!subtreeRoot) {
        throw new Error(`snapshot: element not found: ${selector}`);
      }
    }

    // 进帧 snapshot 的 url/title 取该帧；顶层/子树照旧。
    let url: string;
    let title: string;
    if (targetFrame) {
      url = targetFrame.url;
      title = await frameTitle(targetFrame.frameId);
    } else {
      url = tab.url ?? '';
      title = tab.title ?? '';
    }

    if (mode === 'full') {
      const tree = this.buildTree(nodes, subtreeRoot, targetFrame?.frameId);
      return {
        url,
        title,
        mode: 'full',
        chars: JSON.stringify(tree).length,
        truncated: false,
        tree,
      };
    }

    const compactRoot = subtreeRoot;
    const axNodes = compactRoot
      ? [compactRoot, ...nodes.filter((n) => n.nodeId !== compactRoot.nodeId)]
      : nodes;
    const compact = compactFromAx(
      axNodes,
      mode,
      Boolean(compactRoot),
      targetFrame?.frameId,
      isolatedSrcs,
    );
    const rendered = renderYaml(compact, maxChars);
    return {
      url,
      title,
      mode,
      chars: rendered.chars,
      truncated: rendered.truncated,
      tree: rendered.yaml,
    };
  }

  private buildTree(nodes: AxNode[], subtreeRoot?: AxNode, frameId?: string): SnapshotNode[] {
    const byId = new Map<string, AxNode>();
    for (const node of nodes) byId.set(node.nodeId, node);
    if (nodes.length === 0) return [];

    const formatNode = (node: AxNode): SnapshotNode | SnapshotNode[] | null => {
      const role = node.role?.value as string | undefined;
      if (!role || role === 'none' || role === 'generic') {
        if (node.childIds?.length) {
          const children: (SnapshotNode | SnapshotNode[])[] = [];
          for (const childId of node.childIds) {
            const child = byId.get(childId);
            if (!child) continue;
            const formatted = formatNode(child);
            if (formatted) children.push(formatted);
          }
          if (children.length === 1) return children[0]!;
          if (children.length > 0) return children as SnapshotNode[];
          return null;
        }
        return null;
      }

      const result: SnapshotNode = { role };
      if (node.name?.value) result.name = node.name.value;
      if (node.value?.value) result.value = node.value.value;
      if (node.description?.value) result.description = node.description.value;

      if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId != null) {
        result.ref = `@${assignRef(node.backendDOMNodeId, role, (node.name?.value as string) ?? '', frameId)}`;
      }

      // iframe/frame 角色在 full 模式同样分配 ref（与 compact 对齐，协议 §4.1）。
      const isFrameRole = role === 'iframe' || role === 'frame';
      if (isFrameRole && node.backendDOMNodeId != null) {
        result.ref = `@${assignRef(node.backendDOMNodeId, role, (node.name?.value as string) ?? '', frameId)}`;
      }

      if (node.childIds?.length) {
        const children: SnapshotNode[] = [];
        for (const childId of node.childIds) {
          const child = byId.get(childId);
          if (!child) continue;
          const formatted = formatNode(child);
          if (!formatted) continue;
          if (Array.isArray(formatted)) children.push(...(formatted as SnapshotNode[]));
          else children.push(formatted);
        }
        if (children.length > 0) result.children = children;
      }
      return result;
    };

    const root = subtreeRoot ?? nodes[0]!;
    if (subtreeRoot) {
      const formatted = formatNode(root);
      if (!formatted) return [];
      return Array.isArray(formatted) ? formatted : [formatted];
    }

    const out: SnapshotNode[] = [];
    if (root.childIds) {
      for (const childId of root.childIds) {
        const child = byId.get(childId);
        if (!child) continue;
        const formatted = formatNode(child);
        if (!formatted) continue;
        if (Array.isArray(formatted)) out.push(...(formatted as SnapshotNode[]));
        else out.push(formatted);
      }
    }
    return out;
  }
}

/** 取帧的 document.title（该帧 default world）。异常 → ''。 */
async function frameTitle(frameId: string): Promise<string> {
  try {
    const contextId = await contextIdForFrame(frameId);
    const res = await sendCommand<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: 'document.title',
      contextId,
      returnByValue: true,
    });
    return res.result?.value ?? '';
  } catch {
    return '';
  }
}

function parseMode(raw: unknown): 'compact' | 'interactive' | 'full' {
  if (raw === undefined || raw === null) return 'compact';
  if (typeof raw === 'string' && SNAPSHOT_MODES.has(raw)) {
    return raw as 'compact' | 'interactive' | 'full';
  }
  throw new Error('snapshot: mode must be compact, interactive, or full');
}

function parseMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_CHARS;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_MAX_CHARS ||
    raw > MAX_MAX_CHARS
  ) {
    throw new Error('snapshot: max_chars must be an integer between 1000 and 80000');
  }
  return raw;
}
