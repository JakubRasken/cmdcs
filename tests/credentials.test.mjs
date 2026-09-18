import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { localAuthExists, localAuthMtime, localAuthPath } from '../src/credentials.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cmdcs-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeAuth(name, contents = '{"token":"x"}') {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  return path;
}

test('auth path defaults to ~/.commandcode/auth.json', () => {
  delete process.env.CMDCS_AUTH_FILE;
  assert.equal(localAuthPath(), join(homedir(), '.commandcode', 'auth.json'));
});

test('auth path honours the override', () => {
  const path = writeAuth('auth.json');
  process.env.CMDCS_AUTH_FILE = path;
  try {
    assert.equal(localAuthPath(), path);
    assert.equal(localAuthExists(), true);
    assert.ok(localAuthMtime() > 0);
  } finally {
    delete process.env.CMDCS_AUTH_FILE;
  }
});

test('a missing auth file reports no credentials rather than throwing', () => {
  process.env.CMDCS_AUTH_FILE = join(scratch, 'definitely-absent.json');
  try {
    assert.equal(localAuthExists(), false);
    assert.equal(localAuthMtime(), null);
  } finally {
    delete process.env.CMDCS_AUTH_FILE;
  }
});

test('a newer auth file has a greater mtime than an older one', async () => {
  const older = writeAuth('old.json');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const newer = writeAuth('new.json');

  process.env.CMDCS_AUTH_FILE = older;
  const olderMtime = localAuthMtime();
  process.env.CMDCS_AUTH_FILE = newer;
  const newerMtime = localAuthMtime();
  delete process.env.CMDCS_AUTH_FILE;

  assert.ok(newerMtime > olderMtime, `${newerMtime} should exceed ${olderMtime}`);
});
