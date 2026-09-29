import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'csi-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['docs/protocol.md', 'daemon/internal/tools/tools.go', 'daemon/internal/mcp/tools.go', 'extension/src/background/tools', 'extension/src/background/registry.ts', 'skills/csi/references/http-transport.md']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repo, file), join(root, file), { recursive: true });
  }
  return root;
}
function change(root, file, fn) {
  const path = join(root, file);
  writeFileSync(path, fn(readFileSync(path, 'utf8')));
}
function run(script, root) {
  return spawnSync(process.execPath, [join(repo, 'scripts/skill-ci', script), root], { encoding: 'utf8' });
}
for (const [name, file, mutate, diagnostic, script = 'check-tools.mjs'] of [
  ['duplicate MCP tool', 'daemon/internal/mcp/tools.go', s => s.replace('name:        "navigate",', 'name:        "navigate",\n\t\tname:        "navigate",'), /duplicate/i],
  ['missing registration', 'extension/src/background/registry.ts', s => s.replace(/^.*register\(new NavigateTool.*\n/m, ''), /never registered/i],
  ['duplicate registration', 'extension/src/background/registry.ts', s => s.replace(/^(.*register\(new NavigateTool.*)$/m, '$1\n$1'), /duplicate/i],
  ['empty protocol tools', 'docs/protocol.md', () => '', /empty|missing/i],
  ['schema drift', 'daemon/internal/mcp/tools.go', s => s.replace('"newTab":', '"differentArg":'), /args drift/i, 'check-schemas.mjs'],
  ['duplicate schema property', 'daemon/internal/mcp/tools.go', s => s.replace(/^(\t\t\t"url":.*)$/m, '$1\n$1'), /duplicate/i, 'check-schemas.mjs'],
  ['empty schema sources', 'docs/protocol.md', () => '', /empty|not in protocol/i, 'check-schemas.mjs'],
]) {
  test(name, t => {
    const root = fixture(t);
    const baseline = run(script, root);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    change(root, file, mutate);
    const result = run(script, root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, diagnostic);
  });
}

for (const script of ['check-tools.mjs', 'check-schemas.mjs']) {
  test(`${script} rejects all-empty parsed sources`, t => {
    const root = fixture(t);
    for (const file of ['docs/protocol.md', 'daemon/internal/tools/tools.go', 'daemon/internal/mcp/tools.go', 'extension/src/background/registry.ts', 'skills/csi/references/http-transport.md']) change(root, file, () => '');
    rmSync(join(root, 'extension/src/background/tools'), { recursive: true });
    mkdirSync(join(root, 'extension/src/background/tools'));
    const result = run(script, root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /empty/i);
  });
}
