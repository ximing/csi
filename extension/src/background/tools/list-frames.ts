/**
 * list_frames (protocol §4.21): 当前 tab 的全部帧（含顶层，parentId ""）。
 * isolated:true 的帧本期进不去（跨域 OOPIF / 不透明源 / sandbox）。
 * 输出禁止出现 targetId / session id（协议 §4）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { listAllFrames } from '../frames';

export class ListFramesTool implements Tool {
  readonly name = 'list_frames';

  async execute(_args: ToolArgs): Promise<unknown> {
    await ensureAttached((await getCurrentTab()).id!);
    const frames = await listAllFrames();
    return {
      success: true,
      frames: frames.map((f) => ({
        frameId: f.frameId,
        parentId: f.parentId,
        url: f.url,
        name: f.name,
        isolated: f.isolated,
      })),
    };
  }
}
