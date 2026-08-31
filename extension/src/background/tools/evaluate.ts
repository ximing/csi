/**
 * evaluate (protocol §4.6): Runtime.evaluate with awaitPromise:true.
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';

export class EvaluateTool implements Tool {
  readonly name = 'evaluate';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const code = args.code as string | undefined;
    if (!code) throw new Error('evaluate: code is required');
    const frameArg = parseFrameArg(this.name, args.frame);
    const params: Record<string, unknown> = {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    };
    if (frameArg) {
      params.contextId = await contextIdForFrame(
        target.tabId,
        (await resolveFrame(target.tabId, frameArg)).frameId,
      );
    }
    const result = await sendCommand<{
      exceptionDetails?: { text: string; exception?: { description?: string } };
      result: { type: string; value?: unknown };
    }>(target.tabId, 'Runtime.evaluate', params);
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`evaluate: ${description}`);
    }
    return { type: result.result.type, value: result.result.value };
  }
}
