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
import { resolveObjectId } from './element';
import { compactFromAx, renderYaml, type AxNode } from './ax-yaml';

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

    const tab = await getCurrentTab();
    await ensureAttached(tab.id!);

    // Resolve @e / CSS before resetRefs so a selector from the previous
    // snapshot still maps. New refs start at @e1 after the tree is loaded.
    let backendNodeId: number | undefined;
    if (selector) {
      const objectId = await resolveObjectId('snapshot', selector);
      const described = await sendCommand<{ node?: { backendNodeId?: number } }>(
        'DOM.describeNode',
        { objectId },
      );
      backendNodeId = described.node?.backendNodeId;
      if (backendNodeId == null) {
        throw new Error(`snapshot: element not found: ${selector}`);
      }
    }

    resetRefs();
    const { nodes } = await sendCommand<{ nodes: AxNode[] }>('Accessibility.getFullAXTree');

    let subtreeRoot: AxNode | undefined;
    if (selector) {
      subtreeRoot = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
      if (!subtreeRoot) {
        throw new Error(`snapshot: element not found: ${selector}`);
      }
    }

    if (mode === 'full') {
      const tree = this.buildTree(nodes, subtreeRoot);
      return {
        url: tab.url,
        title: tab.title,
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
    const compact = compactFromAx(axNodes, mode, Boolean(compactRoot));
    const rendered = renderYaml(compact, maxChars);
    return {
      url: tab.url,
      title: tab.title,
      mode,
      chars: rendered.chars,
      truncated: rendered.truncated,
      tree: rendered.yaml,
    };
  }

  private buildTree(nodes: AxNode[], subtreeRoot?: AxNode): SnapshotNode[] {
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
        result.ref = `@${assignRef(node.backendDOMNodeId, role, (node.name?.value as string) ?? '')}`;
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
