import type { ToolArgs } from '../../shared/messages';

export interface TargetContext {
  tabId: number;
  documentEpoch: number;
}

/** A named tool callable from the daemon (protocol §4). */
export interface Tool {
  readonly name: string;
  execute(args: ToolArgs, target: TargetContext): Promise<unknown>;
}
