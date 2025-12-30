/**
 * key_type (protocol §4.9): Input.insertText — types raw text into the
 * focused element.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';

export class KeyTypeTool implements Tool {
  readonly name = 'key_type';

  async execute(args: ToolArgs): Promise<unknown> {
    const text = args.text;
    if (typeof text !== 'string') throw new Error('key_type: text is required (string)');
    await ensureAttached((await getCurrentTab()).id!);
    await sendCommand('Input.insertText', { text });
    return { success: true, length: text.length };
  }
}
