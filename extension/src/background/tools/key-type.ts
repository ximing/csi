/**
 * key_type (protocol §4): Input.insertText — types raw text into the
 * focused element.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';

export class KeyTypeTool implements Tool {
  readonly name = 'key_type';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const text = args.text;
    if (typeof text !== 'string') throw new Error('key_type: text is required (string)');
    await sendCommand(target.tabId, 'Input.insertText', { text });
    return { success: true, length: text.length };
  }
}
