/** 工具业务错误：WS tool_result 可带可选 code/details（协议 §3.3）。 */
export class ToolError extends Error {
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}
