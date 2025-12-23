/**
 * cdp (protocol §4.11): raw CDP passthrough — the escape hatch.
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';

export class CdpTool implements Tool {
  readonly name = 'cdp';

  async execute(args: ToolArgs): Promise<unknown> {
    const method = args.method as string | undefined;
    if (!method) throw new Error('cdp: method is required (e.g., "Input.dispatchMouseEvent")');
    const params = (args.params as object | undefined) ?? {};
    await ensureAttached((await getCurrentTab()).id!);
    const result = await sendCommand<unknown>(method, params);
    if (result == null) return {};
    if (typeof result === 'object' && !Array.isArray(result)) return result;
    return { value: result };
  }
}
