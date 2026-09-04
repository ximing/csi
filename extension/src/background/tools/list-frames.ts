/**
 * list_frames (protocol §4): 当前 tab 的全部帧（含顶层，parentId ""）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { listAllFrames } from '../frames';

export class ListFramesTool implements Tool {
  readonly name = 'list_frames';

  async execute(_args: ToolArgs, target: TargetContext): Promise<unknown> {
    const frames = await listAllFrames(target.tabId);
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
