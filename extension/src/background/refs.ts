/**
 * The `@eN` reference table produced by `snapshot` and consumed by
 * selector-taking tools. Per-tab + per-documentEpoch (协议 §4.1).
 */
import { ToolError } from './tool-error';

export interface RefEntry {
  backendDOMNodeId: number;
  role: string;
  name: string;
  /** 所在帧的 CDP frameId；空/缺省 = 顶层帧（协议 §4.1）。 */
  frameId?: string;
  documentEpoch: number;
}

interface TabRefStore {
  documentEpoch: number;
  nextRef: number;
  refs: Map<string, RefEntry>;
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

const stores = new Map<number, TabRefStore>();

function storeOf(tabId: number): TabRefStore {
  let store = stores.get(tabId);
  if (!store) {
    store = { documentEpoch: 1, nextRef: 1, refs: new Map() };
    stores.set(tabId, store);
  }
  return store;
}

export function currentEpoch(tabId: number): number {
  return storeOf(tabId).documentEpoch;
}

/** Assign the next ref id (`e1`, `e2`, ...) — callers prefix with `@`. */
export function assignRef(
  tabId: number,
  backendDOMNodeId: number,
  role: string,
  name: string,
  frameId?: string,
): string {
  const store = storeOf(tabId);
  const ref = `e${store.nextRef++}`;
  store.refs.set(ref, {
    backendDOMNodeId,
    role,
    name,
    frameId,
    documentEpoch: store.documentEpoch,
  });
  return ref;
}

/** Look up a ref without throwing; accepts both `@e3` and `e3`. */
export function lookupRef(tabId: number, selector: string): RefEntry | undefined {
  const key = selector.startsWith('@') ? selector.slice(1) : selector;
  return stores.get(tabId)?.refs.get(key);
}

/** Lookup + epoch check. unknown_ref vs stale_ref（协议 §4.1）。 */
export function consumeRef(tabId: number, toolName: string, selector: string): RefEntry {
  const key = selector.startsWith('@') ? selector.slice(1) : selector;
  const store = stores.get(tabId);
  const entry = store?.refs.get(key);
  if (!entry) {
    throw new ToolError(
      `${toolName}: unknown ref "${selector}". Run snapshot first to get refs.`,
      'unknown_ref',
      { tabId },
    );
  }
  if (entry.documentEpoch !== store!.documentEpoch) {
    throw new ToolError(
      `${toolName}: stale ref "${selector}". Page navigated; run snapshot again.`,
      'stale_ref',
      { tabId },
    );
  }
  return entry;
}

export function isRefSelector(selector: string): boolean {
  return /^@?e\d+$/.test(selector);
}

/** 只清该 tab 的 refs 与编号；不动 documentEpoch。 */
export function resetRefs(tabId: number): void {
  const store = storeOf(tabId);
  store.refs.clear();
  store.nextRef = 1;
}

export function bumpEpoch(tabId: number, _reason: 'navigate' | 'reload' | 'reattach'): void {
  const store = storeOf(tabId);
  store.documentEpoch += 1;
}

export function deleteTargetState(tabId: number): void {
  stores.delete(tabId);
}

export function staleRefError(toolName: string, selector: string, tabId: number): ToolError {
  return new ToolError(
    `${toolName}: stale ref "${selector}". Page navigated; run snapshot again.`,
    'stale_ref',
    { tabId },
  );
}
