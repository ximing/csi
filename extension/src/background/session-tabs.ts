import type { ToolArgs } from '../shared/messages';

/**
 * Owned tab ids only（协议 §3.4）。永不回退到 `_tabId`——那可能是 borrowed。
 */
export function sessionTabIds(args: ToolArgs): number[] {
  if (!Array.isArray(args._tabIds)) return [];
  return args._tabIds.filter((id) => id !== 0);
}

export function isOwnedTab(args: ToolArgs, tabId: number): boolean {
  return tabId !== 0 && sessionTabIds(args).includes(tabId);
}
