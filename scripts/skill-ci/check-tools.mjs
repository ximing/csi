// 工具清单一致性检查（协议 §2 契约同步）：
//   docs/protocol.md §4 表 == daemon validTools == daemon MCP toolDefs
//   == extension registry 键（tools/*.ts 的 readonly name）== skills/csi 工具索引表
// 五处有任何不一致退出码 1 并列出差异。用法: node scripts/skill-ci/check-tools.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

function sorted(set) {
  return [...set].sort();
}

// 1. 协议 §4 表：| # | `name` | ...  只取 §4 小节（到下一个 ## 为止）
function protocolTools() {
  const doc = read('docs/protocol.md');
  const sec = doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.'));
  const out = new Set();
  for (const m of sec.matchAll(/^\|\s*\d+\s*\|\s*`([a-z_]+)`/gm)) out.add(m[1]);
  return out;
}

// 2. daemon validTools
function daemonTools() {
  const src = read('daemon/internal/tools/tools.go');
  const body = src.slice(src.indexOf('validTools = map[string]bool{'));
  const out = new Set();
  for (const m of body.matchAll(/^\s*"([a-z_]+)":\s*true,/gm)) out.add(m[1]);
  return out;
}

// 3. MCP toolDefs
function mcpTools() {
  const src = read('daemon/internal/mcp/tools.go');
  const out = new Set();
  for (const m of src.matchAll(/^\s*name:\s*"([a-z_]+)",/gm)) out.add(m[1]);
  return out;
}

// 4. extension registry 键 = 各 Tool 的 readonly name（registry.set(tool.name, …)）
function extensionTools() {
  const dir = join(repoRoot, 'extension/src/background/tools');
  const out = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'types.ts') continue;
    const src = readFileSync(join(dir, name), 'utf8');
    const m = src.match(/readonly name = '([a-z_]+)'/);
    if (m) out.add(m[1]);
  }
  return out;
}

// 5. skills/csi 工具索引表（http-transport.md 的 "Tool index" 小节）
function skillTools() {
  const doc = read('skills/csi/references/http-transport.md');
  const start = doc.indexOf('## Tool index');
  if (start < 0) return new Set();
  const rest = doc.slice(start);
  const end = rest.indexOf('\n## ');
  const sec = end < 0 ? rest : rest.slice(0, end);
  const out = new Set();
  for (const m of sec.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)) out.add(m[1]);
  return out;
}

const sources = {
  'protocol §4': protocolTools(),
  'daemon validTools': daemonTools(),
  'daemon mcp toolDefs': mcpTools(),
  'extension registry': extensionTools(),
  'skills/csi tool index': skillTools(),
};

const union = new Set();
for (const set of Object.values(sources)) for (const t of set) union.add(t);

let failures = 0;
for (const [label, set] of Object.entries(sources)) {
  console.log(`[check-tools] ${label}: ${sorted(set).length} tools`);
  const missing = sorted(new Set([...union].filter((t) => !set.has(t))));
  if (missing.length) {
    console.error(`[check-tools] FAIL: ${label} missing: ${missing.join(', ')}`);
    failures++;
  }
}

if (failures > 0) process.exit(1);
console.log(`[check-tools] OK — all 5 sources agree on ${union.size} tools: ${sorted(union).join(', ')}`);
