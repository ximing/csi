/**
 * upload (protocol §4): DOM.setFileInputFiles on a file input.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';

export class UploadTool implements Tool {
  readonly name = 'upload';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const selector = args.selector as string | undefined;
    const files = args.files as string[] | undefined;
    if (!selector) throw new Error('upload: selector is required (CSS selector for file input)');
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('upload: files is required (array of local file paths)');
    }

    const doc = await sendCommand<{ root: { nodeId: number } }>(target.tabId, 'DOM.getDocument');
    const { nodeId } = await sendCommand<{ nodeId: number }>(target.tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`upload: element not found: ${selector}`);

    await sendCommand(target.tabId, 'DOM.setFileInputFiles', { files, nodeId });
    return { success: true, selector, fileCount: files.length, files };
  }
}
