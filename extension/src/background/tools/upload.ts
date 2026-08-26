/**
 * upload (protocol §4): DOM.setFileInputFiles on a file input matched by
 * CSS selector.
 * files 按调用方字面传给 Chrome，不限制基目录（协议 §7）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';

export class UploadTool implements Tool {
  readonly name = 'upload';

  async execute(args: ToolArgs): Promise<unknown> {
    const selector = args.selector as string | undefined;
    const files = args.files as string[] | undefined;
    if (!selector) throw new Error('upload: selector is required (CSS selector for file input)');
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('upload: files is required (array of local file paths)');
    }
    await ensureAttached((await getCurrentTab()).id!);

    const doc = await sendCommand<{ root: { nodeId: number } }>('DOM.getDocument');
    const { nodeId } = await sendCommand<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`upload: element not found: ${selector}`);

    await sendCommand('DOM.setFileInputFiles', { files, nodeId });
    return { success: true, selector, fileCount: files.length, files };
  }
}
