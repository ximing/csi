/**
 * Tool registry + dispatcher. Handles the daemon-injected `_tabId` field
 * (protocol §3.4): for tab-targeted tools it attaches the debugger to that
 * tab first; close_tab / list_tabs / close_session consume `_tabId`
 * themselves.
 */
import type { ToolArgs } from '../shared/messages';
import type { Tool } from './tools/types';
import { ensureAttached, setAttachedTabId } from './debugger-session';
import { ensureGroupRemovedListener } from './tab-group';


const registry = new Map<string, Tool>();

function register(tool: Tool): void {
  registry.set(tool.name, tool);
}

/** Tools that manage `_tabId` themselves instead of being aimed at it. */
const SESSION_SCOPED_TOOLS = new Set(['close_tab', 'list_tabs', 'close_session']);

export function registerAllTools(): void {
  ensureGroupRemovedListener();
}

export async function dispatchTool(name: string, args: ToolArgs): Promise<unknown> {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`unknown tool: ${name}. Available: ${[...registry.keys()].join(', ')}`);
  }

  // The daemon always injects `_tabId`; 0 means "this session has no
  // current tab" (0 is never a valid Chrome tabId) — treat it as absent.
  const tabId = args._tabId;
  if (tabId != null && tabId !== 0 && !SESSION_SCOPED_TOOLS.has(name)) {
    // The daemon's `_tabId` may be stale (user closed the tab manually).
    // Probe first; if the tab is gone, fall through silently so the tool's
    // own getCurrentTab fallback chain (last user tab → active tab) applies
    // (protocol §3.4). Real attach errors for existing tabs still propagate.
    let tabExists = true;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabExists = false;
    }
    if (tabExists) {
      await ensureAttached(tabId);
      setAttachedTabId(tabId);
    }
    delete args._tabId;
  }

  return tool.execute(args);
}
