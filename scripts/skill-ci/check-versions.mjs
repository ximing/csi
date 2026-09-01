#!/usr/bin/env node
// 版本表面对齐闸:daemon version.go / 扩展 manifest+package / 技能 frontmatter / 插件清单 / 根 package.json
// 以 extension/manifest.json 为基准,全部必须相等(退出 1 = 脱节)。
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const read = (p) => readFileSync(`${root}/${p}`, 'utf8');
const json = (p) => JSON.parse(read(p));

const base = json('extension/manifest.json').version;

const surfaces = [
  ['extension/manifest.json', () => json('extension/manifest.json').version],
  ['extension/package.json', () => json('extension/package.json').version],
  ['extension/package-lock.json', () => json('extension/package-lock.json').version],
  ['daemon/internal/version/version.go', () => read('daemon/internal/version/version.go').match(/Version\s*=\s*"([^"]+)"/)?.[1]],
  ['skills/csi/SKILL.md', () => read('skills/csi/SKILL.md').match(/^\s*version:\s*"([^"]+)"/m)?.[1]],
  ['skills/csi-e2e/SKILL.md', () => read('skills/csi-e2e/SKILL.md').match(/^\s*version:\s*"([^"]+)"/m)?.[1]],
  ['package.json', () => json('package.json').version],
  ['.claude-plugin/plugin.json', () => json('.claude-plugin/plugin.json').version],
  ['.claude-plugin/marketplace.json', () => json('.claude-plugin/marketplace.json').plugins?.[0]?.version],
  ['.codex-plugin/plugin.json', () => json('.codex-plugin/plugin.json').version],
  ['.cursor-plugin/plugin.json', () => json('.cursor-plugin/plugin.json').version],
  ['.kimi-plugin/plugin.json', () => json('.kimi-plugin/plugin.json').version],
];

let bad = 0;
for (const [path, get] of surfaces) {
  let v;
  try { v = get(); } catch (e) { console.error(`✗ ${path}: 读取失败 ${e.message}`); bad++; continue; }
  if (v !== base) { console.error(`✗ ${path}: ${v} != ${base}`); bad++; }
  else { console.log(`✓ ${path}: ${v}`); }
}
if (bad) { console.error(`\n${bad} 处版本脱节(基准 ${base})`); process.exit(1); }
console.log(`\nall version surfaces = ${base}`);
