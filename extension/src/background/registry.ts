/**
 * Tool registry + dispatcher. Resolves the target tab, then enqueues on
 * that tab's queue. No silent fallback to last-user / active tab (协议 §3.4).
 */
import type { ToolArgs } from '../shared/messages';
import type { TargetContext, Tool } from './tools/types';
import { ensureAttached } from './debugger-session';
import { ensureGroupRemovedListener } from './tab-group';
import { currentEpoch } from './refs';
import { enqueueTab } from './tab-queue';
import { sessionTabIds } from './session-tabs';
import { asStaleTarget, staleTargetError } from './stale-target';
import { ToolError } from './tool-error';

import { NavigateTool } from './tools/navigate';
import { FindTabTool } from './tools/find-tab';
import { EvaluateTool } from './tools/evaluate';
import { NetworkTool } from './tools/network';
import { SnapshotTool } from './tools/snapshot';
import { ClickTool } from './tools/click';
import { FillTool } from './tools/fill';
import { MouseClickTool } from './tools/mouse-click';
import { CdpTool } from './tools/cdp';
import { KeyTypeTool } from './tools/key-type';
import { SendKeysTool } from './tools/send-keys';
import { WaitTool } from './tools/wait';
import { ScrollTool } from './tools/scroll';
import { HoverTool } from './tools/hover';
import { ScreenshotTool } from './tools/screenshot';
import { SaveAsPdfTool } from './tools/save-as-pdf';
import { UploadTool } from './tools/upload';
import { CloseTabTool } from './tools/close-tab';
import { ListTabsTool } from './tools/list-tabs';
import { ListFramesTool } from './tools/list-frames';
import { CloseSessionTool } from './tools/close-session';

const registry = new Map<string, Tool>();

function register(tool: Tool): void {
  registry.set(tool.name, tool);
}

const TAB_AIMED = new Set([
  'snapshot',
  'click',
  'fill',
  'evaluate',
  'network',
  'mouse_click',
  'wait',
  'scroll',
  'hover',
  'key_type',
  'send_keys',
  'cdp',
  'screenshot',
  'save_as_pdf',
  'upload',
  'list_frames',
]);

export function toolNames(): string[] {
  return [...registry.keys()];
}

export function registerAllTools(): void {
  ensureGroupRemovedListener();
  register(new NavigateTool());
  register(new FindTabTool());
  register(new EvaluateTool());
  register(new NetworkTool());
  register(new SnapshotTool());
  register(new ClickTool());
  register(new FillTool());
  register(new MouseClickTool());
  register(new CdpTool());
  register(new KeyTypeTool());
  register(new SendKeysTool());
  register(new WaitTool());
  register(new ScrollTool());
  register(new HoverTool());
  register(new ScreenshotTool());
  register(new SaveAsPdfTool());
  register(new UploadTool());
  register(new CloseTabTool());
  register(new ListTabsTool());
  register(new ListFramesTool());
  register(new CloseSessionTool());
}

const noneTarget: TargetContext = { tabId: 0, documentEpoch: 0 };

export async function resolveTabTarget(args: ToolArgs): Promise<number> {
  const tabId = args._tabId;
  const session = typeof args._session === 'string' ? args._session : 'default';
  if (tabId == null || tabId === 0) {
    throw new ToolError(
      "session has no current tab; call navigate first, or find_tab(active:true) to borrow the user's tab",
      'no_session_target',
      { session },
    );
  }
  try {
    await chrome.tabs.get(tabId);
  } catch {
    throw staleTargetError(tabId, session);
  }
  return tabId;
}

export async function dispatchTool(name: string, args: ToolArgs): Promise<unknown> {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`unknown tool: ${name}. Available: ${[...registry.keys()].join(', ')}`);
  }

  if (name === 'list_tabs') {
    return tool.execute(args, noneTarget);
  }
  if (name === 'find_tab' || name === 'navigate' || name === 'close_tab' || name === 'close_session') {
    return tool.execute(args, noneTarget);
  }

  if (TAB_AIMED.has(name)) {
    const tabId = await resolveTabTarget(args);
    const session = typeof args._session === 'string' ? args._session : 'default';
    return enqueueTab(tabId, async () => {
      try {
        await ensureAttached(tabId);
      } catch (err) {
        // TOCTOU：resolveTabTarget 的 tabs.get 探针通过后、本任务真正跑到
        // attach 之前，tab 仍可能被用户关掉 → 与探针失败同语义，报 stale_target
        // （daemon 据此 ForgetTab 并补 nextTabId，协议 §3.4）。
        const stale = await asStaleTarget(tabId, session, err);
        if (stale) throw stale;
        // tab 存在但不可 attach（chrome:// 等受限页）：协议暂无对应 code，
        // 保持无 code 的裸错，但补齐 tab 上下文让错误可读。
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`cannot attach debugger to session target tab ${tabId}: ${msg}`);
      }
      try {
        const ctx: TargetContext = { tabId, documentEpoch: currentEpoch(tabId) };
        return await tool.execute(args, ctx);
      } catch (err) {
        // tool.execute 执行期 tab 被关：CDP/tabs API 抛的是无 code 裸错，
        // daemon 只认 stale_target 才 ForgetTab（协议 §3.3/§3.4），这里统一归类。
        // asStaleTarget 先探测 tabs.get：tab 已死即使 err 已是 unknown_ref
        // 也归一为 stale_target；活 tab 上的 ToolError 原样上抛。
        const stale = await asStaleTarget(tabId, session, err);
        if (stale) throw stale;
        throw err;
      }
    });
  }

  return tool.execute(args, noneTarget);
}

export { sessionTabIds };
