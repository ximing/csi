import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { installChrome } from './test-chrome';
installChrome();
const { registerAllTools, toolNames } = await import('./registry');

it('实际注册的工具与协议、daemon 和 MCP 清单一致，重复初始化不会丢失工具', () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
  const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(m => m[1]).sort();
  const doc = read('docs/protocol.md');
  const protocol = names(doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.')), /^\|\s*\d+\s*\|\s*`([a-z_]+)`/gm);
  expect(protocol.length).toBeGreaterThan(0);
  registerAllTools();
  expect(toolNames().sort()).toEqual(protocol);
  expect(names(read('daemon/internal/tools/tools.go'), /^\s*"([a-z_]+)":\s*true,/gm)).toEqual(protocol);
  expect(names(read('daemon/internal/mcp/tools.go'), /^\s*name:\s*"([a-z_]+)",/gm)).toEqual(protocol);
  registerAllTools();
  expect(toolNames().sort()).toEqual(protocol);
});
