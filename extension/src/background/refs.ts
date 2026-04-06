/**
 * The `@eN` reference table produced by `snapshot` and consumed by
 * selector-taking tools (click/fill/mouse_click/screenshot). Refs map to
 * CDP backendDOMNodeIds and are reset on full-page / subtree snapshot,
 * navigation, tab close; frame snapshots append（协议 §4.1）.
 */

export interface RefEntry {
  backendDOMNodeId: number;
  role: string;
  name: string;
  /** 所在帧的 CDP frameId；空/缺省 = 顶层帧（协议 §4.1）。 */
  frameId?: string;
}

/** Roles that get an @eN ref in snapshots (protocol §4, snapshot). */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

const refTable = new Map<string, RefEntry>();
let refCounter = 1;

export function resetRefs(): void {
  refTable.clear();
  refCounter = 1;
}

/** Assign the next ref id (`e1`, `e2`, ...) — callers prefix with `@`. */
export function assignRef(
  backendDOMNodeId: number,
  role: string,
  name: string,
  frameId?: string,
): string {
  const ref = `e${refCounter++}`;
  refTable.set(ref, { backendDOMNodeId, role, name, frameId });
  return ref;
}

/** Look up a ref; accepts both `@e3` and `e3`. */
export function lookupRef(selector: string): RefEntry | undefined {
  const key = selector.startsWith('@') ? selector.slice(1) : selector;
  return refTable.get(key);
}

export function isRefSelector(selector: string): boolean {
  return /^@?e\d+$/.test(selector);
}
