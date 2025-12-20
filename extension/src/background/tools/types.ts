import type { ToolArgs } from '../../shared/messages';

/** A named tool callable from the daemon (protocol §4). */
export interface Tool {
  readonly name: string;
  execute(args: ToolArgs): Promise<unknown>;
}
