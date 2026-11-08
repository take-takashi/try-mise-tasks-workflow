import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('公開タスクだけが実行権限を持つ', { skip: process.platform === 'win32' }, () => {
  const root = fileURLToPath(new URL('../.mise/tasks/', import.meta.url));
  function checkLibrary(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkLibrary(file);
      else if (entry.name.endsWith('.mjs')) assert.equal(fs.statSync(file).mode & 0o111, 0, file);
    }
  }
  for (const name of ['docs', 'mdw']) checkLibrary(path.join(root, name, '_lib'));
  for (const file of ['docs/new.mjs', 'docs/search.mjs', 'docs/validate.mjs', 'mdw/check.mjs',
    'mdw/review.mjs', 'mdw/review/prepare.mjs', 'mdw/review/check.mjs',
    'mdw/review/security.mjs', 'mdw/review/quality.mjs']) {
    assert.notEqual(fs.statSync(path.join(root, file)).mode & 0o111, 0, file);
  }
});
