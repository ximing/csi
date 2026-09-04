/**
 * evaluate (protocol §4 / §4.5): Runtime.evaluate with awaitPromise:true.
 * 序列化结果超 max_chars（默认 12000，最大 80000）时转 artifact（§3.5）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { parseFrameArg } from './element';
import { resolveFrame, contextIdForFrame } from '../frames';
import { makeArtifact, parseResultMaxChars } from './artifact';

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
    const data = { type: result.result.type, value: result.result.value };
    const maxChars = parseResultMaxChars(this.name, args.max_chars);
    const serialized = JSON.stringify(data);
    if (serialized.length <= maxChars) return data;
    // 协议 §4.5：超限转 artifact，preview 是截断标记明示的预览文本，不伪装成合法 JSON。
    return makeArtifact({
      data: serialized,
      mimeType: 'application/json',
      suggestedName: 'csi-evaluate-result.json',
      previewChars: maxChars,
    });
  }
}
