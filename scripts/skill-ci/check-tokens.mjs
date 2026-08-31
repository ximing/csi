// 统计 skills/csi/SKILL.md 的 token 数（js-tiktoken / cl100k_base）。
// 观测项：默认只报告不 fail（能力优先，token 不设硬门槛，见设计 E.1）。
// 显式传 limit 才强制：node scripts/skill-ci/check-tokens.mjs [file] [limit]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = process.argv[2] ?? join(repoRoot, 'skills/csi/SKILL.md');
const limit = process.argv[3] !== undefined ? Number(process.argv[3]) : null;

const text = readFileSync(file, 'utf8');
const enc = getEncoding('cl100k_base');
const count = enc.encode(text).length;

console.log(`[check-tokens] ${file}: ${count} tokens (cl100k_base${limit === null ? ', report-only' : `, limit ${limit}`})`);
if (limit !== null && count > limit) {
  console.error(`[check-tokens] FAIL: ${count} > ${limit}`);
  process.exit(1);
}
console.log('[check-tokens] OK');
