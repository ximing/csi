// 统计 skills/csi/SKILL.md 的 token 数（js-tiktoken / cl100k_base），超过上限则退出码 1。
// 用法: node scripts/skill-ci/check-tokens.mjs [file] [limit]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2] ?? join(repoRoot, 'skills/csi/SKILL.md');
const limit = Number(process.argv[3] ?? 1200);

const text = readFileSync(file, 'utf8');
const enc = getEncoding('cl100k_base');
const count = enc.encode(text).length;

console.log(`[check-tokens] ${file}: ${count} tokens (cl100k_base, limit ${limit})`);
if (count > limit) {
  console.error(`[check-tokens] FAIL: ${count} > ${limit} — shrink the file or move content into references/`);
  process.exit(1);
}
console.log('[check-tokens] OK');
