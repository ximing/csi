/**
 * snapshot (protocol §4): dump the accessibility tree of the current tab
 * via Accessibility.getFullAXTree. Default `mode=compact` returns YAML
 * produced in this process (ax-yaml.ts) before the WS payload; `full`
 * keeps the JSON array. none/generic wrappers are collapsed; interactive
 * roles get an `@eN` ref (backendDOMNodeId mapping, see refs.ts).
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { assignRef, INTERACTIVE_ROLES, resetRefs } from '../refs';
import { resolveObjectId, parseFrameArg } from './element';
import { compactFromAx, contextualInteractive, filterByMatch, matchesSpec, renderYaml, type AxNode, type CompactNode, type IframeInfo, type MatchSpec } from './ax-yaml';
import { INLINE_MAX_CHARS, makeArtifact } from './artifact';
import {
  resolveFrame,
  frameById,
  crossOriginError,
  listAllFrames,
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

/**
 * 解析 snapshot 的 match 参数（协议 §4.3）：object、name 必填、
 * role 可选、exact 默认 true。
 */
function parseMatch(raw: unknown): MatchSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('snapshot: match must be an object like {role?, name, exact?}');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name === '') {
    throw new Error('snapshot: match.name is required');
  }
  if (m.role !== undefined && typeof m.role !== 'string') {
    throw new Error('snapshot: match.role must be a string');
  }
  if (m.exact !== undefined && typeof m.exact !== 'boolean') {
    throw new Error('snapshot: match.exact must be a boolean');
  }
  return { role: m.role as string | undefined, name: m.name, exact: (m.exact as boolean) ?? true };
}

/** full 模式（SnapshotNode JSON 树）的确定性 match 过滤（协议 §4.3）。 */
function filterFullTree(
  nodes: SnapshotNode[],
  spec: MatchSpec,
): { out: SnapshotNode[]; matches: number } {
  let matches = 0;
  const nameOf = (node: SnapshotNode): string =>
    typeof node.name === 'string' ? node.name : node.name == null ? '' : String(node.name);
  const walk = (node: SnapshotNode): SnapshotNode | null => {
    if (matchesSpec({ role: node.role, name: nameOf(node) }, spec)) {
      matches += 1;
      return node;
    }
    if (!node.children?.length) return null;
    const kept: SnapshotNode[] = [];
    for (const child of node.children) {
      const filtered = walk(child);
      if (filtered) kept.push(filtered);
    }
    if (kept.length === 0) return null;
    // 纯上下文行：只留 role+name。
    return { role: node.role, ...(node.name !== undefined ? { name: node.name } : {}), children: kept };
  };
  const out: SnapshotNode[] = [];
  for (const node of nodes) {
    const filtered = walk(node);
    if (filtered) out.push(filtered);
  }
  return { out, matches };
}

export class SnapshotTool implements Tool {
  readonly name = 'snapshot';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const mode = parseMode(args.mode);
    const maxChars = parseMaxChars(args.max_chars);
    const match = parseMatch(args.match);
    const selector =
      typeof args.selector === 'string' && args.selector.length > 0
        ? args.selector
        : undefined;
    const frameArg = parseFrameArg(this.name, args.frame);
    const tabId = target.tabId;
    const tab = await chrome.tabs.get(tabId);

    let preFrame: FrameInfo | undefined;
    if (frameArg) preFrame = await resolveFrame(tabId, frameArg);

    // selector 在 resetRefs 之前解析，旧快照的 @e 仍可用。
    let backendNodeId: number | undefined;
    let targetFrame: FrameInfo | undefined;
    if (selector) {
      const objectId = await resolveObjectId('snapshot', selector, tabId, preFrame?.frameId);
      const described = await sendCommand<{
        node?: { backendNodeId?: number; nodeName?: string; frameId?: string };
      }>(tabId, 'DOM.describeNode', { objectId });
      // 注：CDP 返回的真实字段名是 backendNodeId（下面 else 分支读取的就是它）。
      const node = described.node;
      const nodeName = (node?.nodeName ?? '').toUpperCase();
      if (nodeName === 'IFRAME' || nodeName === 'FRAME') {
        // 入口 1：selector 指向 iframe/frame → 拍它的子帧
        if (!node?.frameId) throw new Error(FRAME_GONE_ERROR);
        targetFrame = await frameById(tabId, node.frameId);
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
    if (!isFrameEntry) resetRefs(tabId); // 整页与普通子树 reset；进帧 snapshot 追加（协议 §4.1）

    const axParams = targetFrame ? { frameId: targetFrame.frameId } : undefined;
    let nodes: AxNode[];
    try {
      ({ nodes } = await sendCommand<{ nodes: AxNode[] }>(
        tabId,
        'Accessibility.getFullAXTree',
        axParams,
      ));
    } catch (err) {
      // 隔离帧到不了这里：frame= 入口经 resolveFrame 已先行抛错（frames.ts），
      // selector→iframe 入口在 isFrameEntry 之前已对 isolated 抛错。
      if (targetFrame) throw new Error(FRAME_GONE_ERROR);
      throw err;
    }
    // iframe 行的 src/isolated 不来自 AX（iframe 节点无 url 属性）：按帧 owner
    // backendDOMNodeId 建表，渲染时对号（协议 §4.1）。isolated 占位帧无 CDP frameId，跳过。
    const frameInfoByNodeId = new Map<number, IframeInfo>();
    for (const f of await listAllFrames(tabId)) {
      if (!f.parentId || f.frameId.startsWith('isolated:')) continue;
      try {
        const { backendNodeId } = await sendCommand<{ backendNodeId: number }>(
          tabId,
          'DOM.getFrameOwner',
          { frameId: f.frameId },
        );
        frameInfoByNodeId.set(backendNodeId, { url: f.url, isolated: f.isolated });
      } catch {
        // 帧已卸载等：跳过
      }
    }

    let subtreeRoot: AxNode | undefined;
    // 进帧入口（selector 指向 iframe，backendNodeId 未设）要整帧树，不做子树过滤；
    // 仅普通 selector 子树（backendNodeId 已设）才在 nodes 里找根（协议 §4.1）。
    if (selector && backendNodeId != null) {
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
      title = await frameTitle(tabId, targetFrame.frameId);
    } else {
      url = tab.url ?? '';
      title = tab.title ?? '';
    }

    if (mode === 'full') {
      let tree = this.buildTree(tabId, nodes, subtreeRoot, targetFrame?.frameId);
      // match 只作用于顶层 snapshot（含 selector 限定的顶层子树）；
      // 进框 snapshot 本期不实现 match 过滤，忽略该参数返回安全超集（协议 §6）。
      let matches: number | undefined;
      if (match && !targetFrame) {
        const filtered = filterFullTree(tree, match);
        tree = filtered.out;
        matches = filtered.matches;
      }
      const json = JSON.stringify(tree);
      if (json.length <= INLINE_MAX_CHARS) {
        return {
          url,
          title,
          mode: 'full',
          chars: json.length,
          source_chars: json.length,
          returned_chars: json.length,
          ...(matches !== undefined ? { matches } : {}),
          truncated: false,
          tree,
        };
      }
      // 协议 §4.3：full 树 >80000 字符自动转 artifact（§3.5），
      // 不截断成非法 JSON，也不返回 result_too_large。
      const env = makeArtifact({
        data: json,
        mimeType: 'application/json',
        suggestedName: 'csi-snapshot-full.json',
        hint: 'Most tasks are cheaper with selector or match to narrow the scope.',
      });
      return {
        url,
        title,
        mode: 'full',
        chars: env.preview.length,
        source_chars: env.sourceChars,
        returned_chars: env.preview.length,
        ...(matches !== undefined ? { matches } : {}),
        truncated: true,
        artifact: env.artifact,
        preview: env.preview,
        sourceChars: env.sourceChars,
      };
    }

    const compactRoot = subtreeRoot;
    const axNodes = compactRoot
      ? [compactRoot, ...nodes.filter((n) => n.nodeId !== compactRoot.nodeId)]
      : nodes;
    // 先取层级树，match 过滤在层级树上做（祖先变上下文行），
    // interactive 的上下文化分组最后应用（协议 §4.3）。
    let roots: CompactNode[] = compactFromAx(
      axNodes,
      'compact',
      Boolean(compactRoot),
      targetFrame?.frameId,
      frameInfoByNodeId,
      tabId,
    );
    let matches: number | undefined;
    if (match && !targetFrame) {
      const filtered = filterByMatch(roots, match);
      roots = filtered.out;
      matches = filtered.matches;
    }
    if (mode === 'interactive') roots = contextualInteractive(roots);
    const rendered = renderYaml(roots, maxChars);
    return {
      url,
      title,
      mode,
      chars: rendered.chars,
      source_chars: rendered.sourceChars,
      returned_chars: rendered.chars,
      ...(matches !== undefined ? { matches } : {}),
      truncated: rendered.truncated,
      tree: rendered.yaml,
    };
  }

  private buildTree(
    tabId: number,
    nodes: AxNode[],
    subtreeRoot?: AxNode,
    frameId?: string,
  ): SnapshotNode[] {
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
        result.ref = `@${assignRef(tabId, node.backendDOMNodeId, role, (node.name?.value as string) ?? '', frameId)}`;
      }

      // iframe/frame 角色在 full 模式同样分配 ref（与 compact 对齐，协议 §4.1）。
      const isFrameRole = role === 'iframe' || role === 'frame';
      if (isFrameRole && node.backendDOMNodeId != null) {
        result.ref = `@${assignRef(tabId, node.backendDOMNodeId, role, (node.name?.value as string) ?? '', frameId)}`;
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
async function frameTitle(tabId: number, frameId: string): Promise<string> {
  try {
    const contextId = await contextIdForFrame(tabId, frameId);
    const res = await sendCommand<{ result?: { value?: string } }>(tabId, 'Runtime.evaluate', {
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
