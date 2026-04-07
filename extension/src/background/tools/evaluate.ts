/**
 * evaluate (protocol §4.6): Runtime.evaluate with awaitPromise:true.
 * This is an arbitrary code execution channel by design (protocol §7).
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached, sendCommand } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

export class EvaluateTool implements Tool {
  readonly name = 'evaluate';

  async execute(args: ToolArgs): Promise<unknown> {
    const code = args.code as string | undefined;
    if (!code) throw new Error('evaluate: code is required');
    await ensureAttached((await getCurrentTab()).id!);
    const frameArg = parseFrameArg(this.name, args.frame);
    const params: Record<string, unknown> = {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    };
    if (frameArg) {
      params.contextId = await contextIdForFrame((await resolveFrame(frameArg)).frameId);
    }
    const result = await sendCommand<{
      exceptionDetails?: { text: string; exception?: { description?: string } };
      result: { type: string; value?: unknown };
    }>('Runtime.evaluate', params);
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`evaluate: ${description}`);
    }
    return { type: result.result.type, value: result.result.value };
  }
}
