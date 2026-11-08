import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-docs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(project, '.mise/tasks/docs'), path.join(root, '.mise/tasks/docs'), { recursive: true });
  const env = { ...process.env, MISE_YES: '1' };
  delete env.MISE_ORIGINAL_CWD;
  const run = (args, cwd = root) => spawnSync('mise', args, { cwd, env, encoding: 'utf8' });
  return { root, run };
}

test('コピーしたDocsタスクを検出し、ADRを作成、検索、検証する', t => {
  const { root, run } = setup(t);
  const listing = run(['tasks', 'ls', '--json']);
  assert.equal(listing.status, 0, listing.stderr);
  const names = new Set(JSON.parse(listing.stdout).map(item => item.name));
  for (const name of ['docs:new', 'docs:search', 'docs:validate']) assert.ok(names.has(name));
  assert.ok(![...names].some(name => name.startsWith('docs:_lib:')));
  const help = run(['run', 'docs:new', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /<type>/);
  assert.match(help.stdout, /<title>/);
  const created = run(['run', 'docs:new', 'adr', '日本語の設計判断']);
  assert.equal(created.status, 0, created.stderr);
  const document = JSON.parse(created.stdout).document;
  assert.equal(document.id, 'ADR-0001');
  assert.match(fs.readFileSync(path.join(root, document.path), 'utf8'), /日本語の設計判断/);
  const second = run(['run', 'docs:new', 'adr', '二件目']);
  assert.equal(JSON.parse(second.stdout).document.id, 'ADR-0002');
  fs.appendFileSync(path.join(root, 'docs/decisions/0002.md'), '\n[[ADR-0001]]\n');
  const found = run(['run', 'docs:search', '日本語'], path.join(root, 'docs'));
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).documents[0].path, document.path);
  assert.deepEqual(JSON.parse(run(['run', 'docs:search', '見つからない語句']).stdout).documents, []);
  fs.appendFileSync(path.join(root, document.path), '\nStraße と ﬃ と ς\n');
  for (const query of ['STRASSE', 'FFI', 'Σ']) {
    const match = run(['run', 'docs:search', query]);
    assert.equal(match.status, 0, match.stderr);
    assert.equal(JSON.parse(match.stdout).documents[0].id, 'ADR-0001');
  }
  const valid = run(['run', 'docs:validate']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).checked, 2);
});

test('不正な入力、重複ID、壊れたメタデータと参照を報告する', t => {
  const { root, run } = setup(t);
  const invalid = run(['run', 'docs:new', 'other', '題名']);
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'docs')));
  assert.equal(run(['run', 'docs:new', 'adr', '判断']).status, 0);
  const original = path.join(root, 'docs/decisions/0001.md');
  fs.writeFileSync(path.join(root, 'docs/decisions/0001-copy.md'), fs.readFileSync(original, 'utf8') + '\n[[ADR-9999]]\n');
  fs.writeFileSync(path.join(root, 'docs/decisions/0002.md'), '---\nnot json\n---\n');
  const result = run(['run', 'docs:validate']);
  assert.notEqual(result.status, 0);
  const errors = JSON.parse(result.stdout).errors.map(item => item.message).join('\n');
  assert.match(errors, /重複/);
  assert.match(errors, /参照先/);
  assert.match(errors, /JSON/);
});
