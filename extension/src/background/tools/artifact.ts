/**
 * 结果预算与 artifact 信封的公共 helper（协议 §3.5 / §4.5）。
 * snapshot(full) / network(detail) / evaluate / cdp 复用：
 * 超预算时不内联完整内容，改产出 {artifact, preview, sourceChars}，
 * 由 daemon 落盘并改写为客户端信封。
 *
 * preview 是「明示的预览文本」：内容是完整结果的前缀裁剪，
 * 尾部带显式截断标记，绝不伪装成合法 JSON（协议 §4.5）。
 */
import type { ArtifactEnvelope } from '../../shared/messages';

/** 内联结果预算硬上限（协议 §4.3/§4.5）。 */
export const INLINE_MAX_CHARS = 80_000;
/** 结果预算参数（evaluate/cdp 的 max_chars，network preview）的默认值/预览长度。 */
export const DEFAULT_PREVIEW_CHARS = 12_000;
/** 协议未定 preview 参数：artifact preview 固定取前 12000 字符。 */

export interface ArtifactOptions {
  /** 完整内容（utf8 字符串），原样进 artifact.data，不裁剪。 */
  data: string;
  mimeType: string;
  suggestedName: string;
  /** preview 长度，默认 12000。 */
  previewChars?: number;
  /** 附加在截断标记后的引导语（如 snapshot full 的 scope 建议）。 */
  hint?: string;
}

export function makeArtifact(opts: ArtifactOptions): ArtifactEnvelope {
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const head = opts.data.slice(0, previewChars);
  const omitted = opts.data.length - head.length;
  let marker = `\n... preview truncated, ${omitted} chars omitted; full content saved to artifact "${opts.suggestedName}" (${opts.data.length} chars total).`;
  if (opts.hint) marker += ` ${opts.hint}`;
  return {
    artifact: {
      encoding: 'utf8',
      mimeType: opts.mimeType,
      suggestedName: opts.suggestedName,
      data: opts.data,
    },
    preview: head + marker,
    sourceChars: opts.data.length,
  };
}

/**
 * 解析 evaluate/cdp 的 max_chars（协议 §4.5：默认 12000，最大 80000）。
 * 协议未给下限，只校验「正整数 ≤ 80000」。
 */
export function parseResultMaxChars(tool: string, raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_PREVIEW_CHARS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > INLINE_MAX_CHARS) {
    throw new Error(`${tool}: max_chars must be an integer between 1 and 80000`);
  }
  return raw;
}
