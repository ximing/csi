/**
 * snapshot (protocol §4.3): dump the accessibility tree of the current tab
 * via Accessibility.getFullAXTree. none/generic wrappers are collapsed;
 * interactive roles get an `@eN` ref (backendDOMNodeId mapping, see refs.ts).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { assignRef, INTERACTIVE_ROLES, resetRefs } from '../refs';

interface AXValue {
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  backendDOMNodeId?: number;
  childIds?: string[];
}

export interface SnapshotNode {
  role: string;
  name?: unknown;
  value?: unknown;
  description?: unknown;
  ref?: string;
  children?: SnapshotNode[];
}

export class SnapshotTool implements Tool {
  readonly name = 'snapshot';

  async execute(_args: ToolArgs): Promise<unknown> {
    const tab = await getCurrentTab();
    await ensureAttached(tab.id!);
    resetRefs();
    const { nodes } = await sendCommand<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const tree = this.buildTree(nodes);
    return { url: tab.url, title: tab.title, tree };
  }

  private buildTree(nodes: AXNode[]): SnapshotNode[] {
    const byId = new Map<string, AXNode>();
    for (const node of nodes) byId.set(node.nodeId, node);
    if (nodes.length === 0) return [];
    return this.formatChildren(nodes[0]!, byId);
  }

  private formatChildren(root: AXNode, byId: Map<string, AXNode>): SnapshotNode[] {
    const out: SnapshotNode[] = [];

    // Returns a SnapshotNode, an array of them (collapsed wrappers), or null.
    const formatNode = (node: AXNode): SnapshotNode | SnapshotNode[] | null => {
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
