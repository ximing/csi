// 工具参数（schema）一致性检查：docs/protocol.md §4 各工具 args 列声明的参数名
// 必须等于 daemon/internal/mcp/tools.go 对应 toolDef 的 props 键（顶层参数，session 除外）。
// 某一侧加/删参数而另一侧未同步 → 退出码 1 并列出差异。用法: node scripts/skill-ci/check-schemas.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

// 1. 协议 §4 args 列：取 `| N | `name` | <args> |` 第三列；剥掉括号注释（含 `match`({role?,…})
//    这类嵌套说明），再收集反引号参数名。`—` 行无参数。
function protocolArgs() {
  const doc = read('docs/protocol.md');
  const sec = doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.'));
  const out = new Map();
  for (const m of sec.matchAll(/^\|\s*\d+\s*\|\s*`([a-z_]+)`\s*\|\s*((?:\\.|[^|])*)\|/gm)) {
    const cell = m[2].replace(/\([^)]*\)/g, '');
    const args = new Set();
    for (const t of cell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) args.add(t[1]);
    out.set(m[1], args);
  }
  return out;
}

// 2. MCP toolDefs：每个 toolDef 的 props 顶层键（3 个 tab 缩进的 "key": 行；嵌套对象忽略）。
function mcpArgs() {
  const lines = read('daemon/internal/mcp/tools.go').split('\n');
  const out = new Map();
  let tool = null;
  let inProps = false;
  for (const line of lines) {
    const nameM = line.match(/^\t\tname:\s*"([a-z_]+)",/);
    if (nameM) {
      tool = nameM[1];
      if (!out.has(tool)) out.set(tool, new Set());
      continue;
    }
    if (!tool) continue;
    if (/^\t\tprops: map\[string\]any\{/.test(line)) {
      inProps = true;
      continue;
    }
    if (inProps) {
      const keyM = line.match(/^\t\t\t"([^"]+)":/);
      if (keyM) {
        out.get(tool).add(keyM[1]);
        continue;
      }
      if (/^\t\t\},/.test(line)) inProps = false;
    }
  }
  return out;
}

const protocol = protocolArgs();
const mcp = mcpArgs();

let failures = 0;
const tools = new Set([...protocol.keys(), ...mcp.keys()]);
for (const tool of [...tools].sort()) {
  const p = protocol.get(tool);
  const m = mcp.get(tool);
  if (!p) {
    console.error(`[check-schemas] FAIL: ${tool} in MCP toolDefs but not in protocol §4`);
    failures++;
    continue;
  }
  if (!m) {
    console.error(`[check-schemas] FAIL: ${tool} in protocol §4 but not in MCP toolDefs`);
    failures++;
    continue;
  }
  const onlyProtocol = [...p].filter((a) => !m.has(a)).sort();
  const onlyMcp = [...m].filter((a) => !p.has(a)).sort();
  if (onlyProtocol.length || onlyMcp.length) {
    console.error(
      `[check-schemas] FAIL: ${tool} args drift — protocol-only: [${onlyProtocol.join(', ')}] | mcp-only: [${onlyMcp.join(', ')}]`,
    );
    failures++;
  } else {
    console.log(`[check-schemas] ${tool}: ${p.size} args OK`);
  }
}

if (failures > 0) process.exit(1);
console.log(`[check-schemas] OK — protocol §4 args and MCP schemas agree for ${tools.size} tools`);
