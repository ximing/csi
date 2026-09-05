/**
 * upload (protocol §4): DOM.setFileInputFiles on a file input.
 * selector is CSS or @e ref; no frame arg (CSS hits the top document only).
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { resolveObjectId } from './element';

export class UploadTool implements Tool {
  readonly name = 'upload';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const selector = args.selector as string | undefined;
    const files = args.files as string[] | undefined;
    if (!selector) throw new Error('upload: selector is required (CSS selector or @e ref)');
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('upload: files is required (array of local file paths)');
    }

    const objectId = await resolveObjectId(this.name, selector, target.tabId);
    await sendCommand(target.tabId, 'DOM.setFileInputFiles', { files, objectId });
    return { success: true, selector, fileCount: files.length, files };
  }
}
