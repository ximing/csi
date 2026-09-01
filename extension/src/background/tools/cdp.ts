/**
 * cdp (protocol §4.2 / §4.4): raw CDP passthrough — the escape hatch.
 * 规范化结果序列化后超 max_chars（默认 12000，最大 80000）时转 artifact（§3.5）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { TargetContext, Tool } from './types';
import { sendCommand } from '../debugger-session';
import { makeArtifact, parseResultMaxChars } from './artifact';

export class CdpTool implements Tool {
  readonly name = 'cdp';

  async execute(args: ToolArgs, target: TargetContext): Promise<unknown> {
    const method = args.method as string | undefined;
    if (!method) throw new Error('cdp: method is required (e.g., "Input.dispatchMouseEvent")');
    const params = (args.params as object | undefined) ?? {};
    const result = await sendCommand<unknown>(target.tabId, method, params);

    // 协议 §4.2：null/undefined → {}；非数组 object 原样；数组/原始值包装成 {value}。
    let data: unknown;
    if (result == null) data = {};
    else if (typeof result === 'object' && !Array.isArray(result)) data = result;
    else data = { value: result };

    const maxChars = parseResultMaxChars(this.name, args.max_chars);
    const serialized = JSON.stringify(data);
    if (serialized.length <= maxChars) return data;
    // 协议 §4.4：超限转 artifact，不从 JSON 中间裁切后伪装成合法对象。
    return makeArtifact({
      data: serialized,
      mimeType: 'application/json',
      suggestedName: 'csi-cdp-result.json',
      previewChars: maxChars,
    });
  }
}
