/**
 * Compact YAML formatter for snapshot (protocol §4). YAML is produced here
 * in the extension so the WS payload is already slim — not a JSON tree.
 *
 * Example 1 — heading + textbox + iframe (iframe does not descend):
 *
 *   heading "Sign in" level=1 + textbox Email ref + iframe recaptcha
 *   (iframe has a child button that must not appear)
 *   →
 *   - heading "Sign in" [level=1]
 *   - textbox "Email" [ref=@e1]
 *   - iframe "reCAPTCHA" [src=https://www.google.com/recaptcha/…] [isolated] [ref=@e2]
 *
 * Example 2 — text already in the nearest ancestor name is dropped:
 *
 *   button name="Submit" with child StaticText "Submit"
 *   →
 *   - button "Submit" [ref=@e1]
 *   (no separate `- text "Submit"` line)
 */
import { assignRef, INTERACTIVE_ROLES } from '../refs';

export type AxValue = { value?: unknown };
export type AxProp = { name: string; value?: AxValue };
export type AxNode = {
  nodeId: string;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: AxProp[];
};

export type CompactNode = {
  role: string;
  name?: string;
  value?: string;
  ref?: string;
  level?: number;
  /** Present only when the AX node has a `checked` property. */
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  isolated?: boolean;
  src?: string;
  children?: CompactNode[];
};

export const STRUCTURAL_ROLES = new Set([
  'heading', 'paragraph', 'list', 'listitem', 'navigation', 'main',
  'banner', 'contentinfo', 'complementary', 'form', 'article', 'region',
  'img', 'table', 'row', 'rowheader', 'columnheader', 'cell', 'caption',
  'blockquote', 'separator', 'status', 'alert', 'dialog', 'iframe', 'frame', 'text',
]);

const NAME_LIMIT = 120;
const SRC_LIMIT = 80;
const ELLIPSIS = '…';
const TRUNCATED_HINT =
  'Re-snapshot with selector or mode=interactive.';

export interface IframeInfo {
  url: string;
  isolated: boolean;
}

export function compactFromAx(
  nodes: AxNode[],
  mode: 'compact' | 'interactive',
  includeRoot = false,
  frameId?: string,
  frameInfoByNodeId?: Map<number, IframeInfo>,
  tabId = 0,
): CompactNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);
  const root = nodes[0]!;
  // Whole-page trees start at RootWebArea whose name is <title>. Walking
  // that node would copy the title into nearestName and wipe matching text.
  // Unscoped: children only (same as full's formatChildren). Selector: include self.
  const formatted = includeRoot
    ? formatNode(root, byId, '', frameId, frameInfoByNodeId, tabId)
    : collectChildren(
        root,
        byId,
        '',
        normalizeRole(rawRole(root)),
        frameId,
        frameInfoByNodeId,
        tabId,
      );
  const roots = asList(formatted);
  return mode === 'interactive' ? flattenInteractive(roots) : roots;
}

export function renderYaml(
  nodes: CompactNode[],
  maxChars: number,
): { yaml: string; chars: number; truncated: boolean } {
  const lines: string[] = [];
  const walk = (node: CompactNode, depth: number): void => {
    lines.push(formatLine(node, depth));
    if (node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  for (const node of nodes) walk(node, 0);

  const yaml = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  if (yaml.length <= maxChars) {
    return { yaml, chars: yaml.length, truncated: false };
  }

  const nl = yaml.lastIndexOf('\n', maxChars - 1);
  const kept = nl >= 0 ? yaml.slice(0, nl) : yaml.slice(0, maxChars);
  const omitted = yaml.length - kept.length;
  const truncated =
    `${kept}\n... truncated, ${omitted} chars omitted. ${TRUNCATED_HINT}`;
  return { yaml: truncated, chars: truncated.length, truncated: true };
}

function formatNode(
  node: AxNode,
  byId: Map<string, AxNode>,
  nearestName: string,
  frameId?: string,
  frameInfoByNodeId?: Map<number, IframeInfo>,
  tabId = 0,
): CompactNode | CompactNode[] | null {
  const role = normalizeRole(rawRole(node));
  const name = axString(node.name?.value);
  const nextNearest = name || nearestName;
  const isInteractive = INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId != null;
  const isStructural = STRUCTURAL_ROLES.has(role);

  if (role === 'text' && name && nearestName.includes(name)) {
    return collectChildren(node, byId, nextNearest, role, frameId, frameInfoByNodeId, tabId);
  }

  if (!isInteractive && !isStructural) {
    return collectChildren(node, byId, nextNearest, role, frameId, frameInfoByNodeId, tabId);
  }

  const result: CompactNode = { role };
  if (name) result.name = clipName(name);

  const value = axString(node.value?.value);
  if (value) result.value = clipName(value);

  const level = numericProp(node, 'level');
  if (level != null) result.level = level;

  if (hasProp(node, 'checked')) {
    result.checked = isAxTrue(propValue(node, 'checked'));
  }
  if (isAxTrue(propValue(node, 'selected'))) result.selected = true;
  if (isAxTrue(propValue(node, 'expanded'))) result.expanded = true;
  if (isAxTrue(propValue(node, 'disabled'))) result.disabled = true;
  if (isAxTrue(propValue(node, 'invalid'))) result.invalid = true;

  if (role === 'img') {
    const url = axString(propValue(node, 'url'));
    if (url) result.src = url.length > SRC_LIMIT ? url.slice(0, SRC_LIMIT) : url;
  }

  const isFrameRole = role === 'iframe' || role === 'frame';
  if (isFrameRole && node.backendDOMNodeId != null) {
    // iframe/frame 也进 ref 表（协议 §4.1：snapshot({selector:"@eN"}) 进框入口）。
    // AX iframe 节点无 url 属性，src 与 isolated 按帧 owner backendDOMNodeId 从帧清单取（协议 §4.1）。
    result.ref = `@${assignRef(tabId, node.backendDOMNodeId, role, name, frameId)}`;
    const fi = frameInfoByNodeId?.get(node.backendDOMNodeId);
    if (fi?.url) result.src = fi.url.length > SRC_LIMIT ? fi.url.slice(0, SRC_LIMIT) : fi.url;
    if (fi?.isolated) result.isolated = true;
  }

  if (isInteractive) {
    result.ref = `@${assignRef(tabId, node.backendDOMNodeId!, role, name, frameId)}`;
  }

  const children = collectChildren(
    node,
    byId,
    nextNearest,
    role,
    frameId,
    frameInfoByNodeId,
    tabId,
  );
  const childList = asList(children);
  if (childList.length > 0) result.children = childList;

  if (!result.name && !result.value && !result.ref && !result.src && !result.children) {
    return null;
  }
  return result;
}

function collectChildren(
  node: AxNode,
  byId: Map<string, AxNode>,
  nearestName: string,
  role: string,
  frameId?: string,
  frameInfoByNodeId?: Map<number, IframeInfo>,
  tabId = 0,
): CompactNode | CompactNode[] | null {
  if (role === 'iframe' || role === 'frame' || !node.childIds?.length) return null;
  const children: CompactNode[] = [];
  for (const childId of node.childIds) {
    const child = byId.get(childId);
    if (!child) continue;
    const formatted = formatNode(child, byId, nearestName, frameId, frameInfoByNodeId, tabId);
    if (!formatted) continue;
    if (Array.isArray(formatted)) children.push(...formatted);
    else children.push(formatted);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return children;
}

function flattenInteractive(nodes: CompactNode[]): CompactNode[] {
  const out: CompactNode[] = [];
  const walk = (node: CompactNode): void => {
    if (node.ref) {
      const { children: _children, ...rest } = node;
      out.push(rest);
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  for (const node of nodes) walk(node);
  return out;
}

function formatLine(node: CompactNode, depth: number): string {
  const parts: string[] = [`${'  '.repeat(depth)}- ${node.role}`];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.level != null) parts.push(`[level=${node.level}]`);
  if (node.checked === true) parts.push('[checked]');
  else if (node.checked === false) parts.push('[unchecked]');
  if (node.selected) parts.push('[selected]');
  if (node.expanded) parts.push('[expanded]');
  if (node.disabled) parts.push('[disabled]');
  if (node.invalid) parts.push('[invalid]');
  if (node.isolated) parts.push('[isolated]');
  if (node.src) parts.push(`[src=${node.src}]`);
  if (node.ref) parts.push(`[ref=${node.ref}]`);
  let line = parts.join(' ');
  if (node.value) line += `: ${JSON.stringify(node.value)}`;
  return line;
}

function normalizeRole(raw: string): string {
  if (raw === 'StaticText' || raw.toLowerCase() === 'statictext') return 'text';
  return raw.toLowerCase();
}

function rawRole(node: AxNode): string {
  return typeof node.role?.value === 'string' ? node.role.value : '';
}

function axString(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function clipName(text: string): string {
  return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT - 1) + ELLIPSIS : text;
}

function hasProp(node: AxNode, name: string): boolean {
  return node.properties?.some((p) => p.name === name) ?? false;
}

function propValue(node: AxNode, name: string): unknown {
  const prop = node.properties?.find((p) => p.name === name);
  return prop?.value?.value;
}

function numericProp(node: AxNode, name: string): number | undefined {
  const raw = propValue(node, name);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isAxTrue(value: unknown): boolean {
  if (value == null || value === false || value === 'false' || value === 0 || value === '') {
    return false;
  }
  return true;
}

function asList(node: CompactNode | CompactNode[] | null): CompactNode[] {
  if (!node) return [];
  return Array.isArray(node) ? node : [node];
}
