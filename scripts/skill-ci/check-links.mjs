// 检查 skills/csi 下 SKILL.md 与 references/*.md 中引用的本地文件都存在。
// 收集两种引用：(a) markdown 链接 [text](target)；(b) 行内代码里以 .md 结尾的路径。
// 跳过 http(s)/mailto/锚点；target 可带 #section 后缀。用法: node scripts/skill-ci/check-links.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillDir = join(repoRoot, 'skills', 'csi');

const files = [join(skillDir, 'SKILL.md')];
for (const name of readdirSync(join(skillDir, 'references'))) {
  if (name.endsWith('.md')) files.push(join(skillDir, 'references', name));
}

const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
const codePathRe = /`((?:[\w.-]+\/)*[\w.-]+\.md)`/g;

let failures = 0;
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const targets = new Set();
  for (const m of text.matchAll(linkRe)) targets.add(m[1]);
  for (const m of text.matchAll(codePathRe)) targets.add(m[1]);
  for (const raw of targets) {
    if (/^([a-z]+:|#)/i.test(raw)) continue; // http(s):、mailto:、纯锚点
    const target = raw.split('#')[0];
    if (!target) continue;
    checked++;
    const abs = resolve(dirname(file), target);
    if (!existsSync(abs)) {
      // SKILL.md 用 references/foo.md 形式；references 内部用同目录相对名
      const alt = resolve(skillDir, target);
      if (!existsSync(alt)) {
        console.error(`[check-links] FAIL: ${file} references missing file "${raw}"`);
        failures++;
      }
    }
  }
}

if (failures > 0) process.exit(1);
console.log(`[check-links] OK — ${checked} local references across ${files.length} files all exist`);
