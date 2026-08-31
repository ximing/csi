// 工具清单一致性检查（协议 §2 契约同步）：
//   docs/protocol.md §4 表 == daemon validTools == daemon MCP toolDefs
//   == extension registry 键（tools/*.ts 的 readonly name）== skills/csi 工具索引表
// 五处有任何不一致退出码 1 并列出差异。另做 extension 内部双向核对：
// tools/*.ts 的每个工具类必须在 registry.ts 的 registerAllTools() 里注册，
// 反之亦然（防"五源都列了工具但忘了 register → 运行时 unknown tool"）。
// 用法: node scripts/skill-ci/check-tools.mjs
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

// 4a. extension 内部核对：tools/*.ts 声明的工具类（export class XxxTool，含 readonly name）
function extensionToolClasses() {
  const dir = join(repoRoot, 'extension/src/background/tools');
  const out = new Map(); // 类名 → 文件名
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'types.ts') continue;
    const src = readFileSync(join(dir, name), 'utf8');
    if (!/readonly name = '[a-z_]+'/.test(src)) continue;
    const m = src.match(/export class (\w+)/);
    if (m) out.set(m[1], name);
  }
  return out;
}

// 4b. registry.ts 的 registerAllTools() 里 register/register*(new XxxTool()) 的类名
function registeredToolClasses() {
  const src = read('extension/src/background/registry.ts');
  const start = src.indexOf('export function registerAllTools()');
  const end = src.indexOf('\n}', start); // 函数体到列 0 的右花括号为止
  // 剥掉行注释，避免把注释掉的 register 调用算作已注册
  const body = (end < 0 ? src.slice(start) : src.slice(start, end)).replace(/\/\/[^\n]*/g, '');
  const out = new Set();
  for (const m of body.matchAll(/\bregister\w*\(\s*new\s+(\w+)\s*\(/g)) out.add(m[1]);
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

// extension 内部核对：工具类 ↔ registerAllTools() 注册，双向
const toolClasses = extensionToolClasses();
const registered = registeredToolClasses();
const unregistered = [...toolClasses.keys()].filter((c) => !registered.has(c)).sort();
const unknownRegistered = [...registered].filter((c) => !toolClasses.has(c)).sort();
if (unregistered.length) {
  console.error(
    `[check-tools] FAIL: tools/*.ts classes never registered in registerAllTools(): ${unregistered
      .map((c) => `${c} (${toolClasses.get(c)})`)
      .join(', ')}`,
  );
  failures++;
}
if (unknownRegistered.length) {
  console.error(
    `[check-tools] FAIL: registerAllTools() registers classes not found in tools/*.ts: ${unknownRegistered.join(', ')}`,
  );
  failures++;
}
if (!unregistered.length && !unknownRegistered.length) {
  console.log(`[check-tools] registry.ts registerAllTools(): ${registered.size} classes registered OK`);
}

if (failures > 0) process.exit(1);
console.log(`[check-tools] OK — all 5 sources agree on ${union.size} tools: ${sorted(union).join(', ')}`);
