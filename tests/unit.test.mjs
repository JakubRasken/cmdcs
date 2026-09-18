import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCodespaces, isReady, isStopped } from '../src/gh.mjs';
import { parseRemoteProbe, probeRemote, REMOTE_BOOTSTRAP, CMDC_BIN, CMDC_NAME, nodeIsSupported, nodeMajor, remoteCmdcPath } from '../src/env.mjs';
import { buildRemoteCommand, shellQuote } from '../src/codespace.mjs';
import { quoteForCmdShim, isWindows } from '../src/proc.mjs';

test('parses the codespace list payload', () => {
  const payload = JSON.stringify([
    {
      name: 'fluffy-space-guide-abc123',
      displayName: 'my-repo',
      repository: 'user/my-repo',
      state: 'Available',
      machine: 'standardLinux32gb',
      lastUsedAt: '2026-09-01T00:00:00Z',
    },
  ]);

  const [codespace] = parseCodespaces(payload);
  assert.equal(codespace.name, 'fluffy-space-guide-abc123');
  assert.equal(codespace.repository, 'user/my-repo');
  assert.equal(isReady(codespace), true);
  assert.equal(isStopped(codespace), false);
});

test('shutdown codespaces are not ready but are startable', () => {
  const codespace = { name: 'a', state: 'Shutdown' };
  assert.equal(isReady(codespace), false);
  assert.equal(isStopped(codespace), true);
});

test('an empty list is not an error', () => {
  assert.deepEqual(parseCodespaces(''), []);
  assert.deepEqual(parseCodespaces('  '), []);
});

test('unparseable list output raises a clear error', () => {
  assert.throws(() => parseCodespaces('not json at all'), /Could not parse/);
});

test('probe parses node, npm and cmdc paths from a login shell', () => {
  const stdout = ['v20.11.1', '10.2.4', '/home/codespace/.local/bin/cmdc'].join('\n');
  assert.deepEqual(parseRemoteProbe(stdout), {
    node: 'v20.11.1',
    npm: '10.2.4',
    cmdc: '/home/codespace/.local/bin/cmdc',
  });
});

test('probe treats a missing cmdc as not installed', () => {
  const parsed = parseRemoteProbe(['v20.11.1', '10.2.4', 'none'].join('\n'));
  assert.equal(parsed.cmdc, null);
  assert.equal(parsed.node, 'v20.11.1');
});

test('probe tolerates shell noise and a missing node', () => {
  const parsed = parseRemoteProbe(['nvm: command not found', 'none'].join('\n'));
  assert.equal(parsed.node, null);
  assert.equal(parsed.cmdc, null);
});

test('the remote probe always asks for the portable name, never the local one', () => {
  const probe = probeRemote();

  // A Windows client driving a Linux codespace must still probe for `cmdc`.
  // Using the local name here asked the codespace for `cmdc.cmd` and reported
  // "not installed" for a perfectly good install.
  assert.ok(probe.includes(`command -v ${CMDC_NAME}`));
  assert.ok(!probe.includes('command -v cmdc.cmd'));
  assert.ok(!/\bcommand -v cmd\b/.test(probe));
  assert.ok(!probe.includes('commandcode'));
});

test('the local binary name is platform-specific', () => {
  const expected = isWindows ? 'cmdc.cmd' : 'cmdc';
  assert.equal(CMDC_BIN, expected);
  assert.equal(CMDC_NAME, 'cmdc');
});

test('remote bootstrap sources nvm, fnm and common bin dirs', () => {
  assert.match(REMOTE_BOOTSTRAP, /NVM_DIR/);
  assert.match(REMOTE_BOOTSTRAP, /fnm env/);
  assert.match(REMOTE_BOOTSTRAP, /\.local\/bin/);
});

test('remote bootstrap resolves the global npm prefix with a devcontainer fallback', () => {
  assert.match(REMOTE_BOOTSTRAP, /npm prefix -g/);
  assert.match(REMOTE_BOOTSTRAP, /usr\/local\/share\/nvm\/current\/bin/);
  assert.match(remoteCmdcPath(), /npm prefix -g/);
  assert.ok(remoteCmdcPath().endsWith(`/bin/${CMDC_NAME}"`));
});

test('node >= 22 is required, below that is rejected', () => {
  assert.equal(nodeMajor('v22.11.0'), 22);
  assert.equal(nodeMajor('v18.20.4'), 18);
  assert.equal(nodeMajor(null), null);

  assert.equal(nodeIsSupported('v22.11.0'), true);
  assert.equal(nodeIsSupported('v24.19.0'), true);
  assert.equal(nodeIsSupported('v20.11.1'), false);
  assert.equal(nodeIsSupported(null), false);
});

test('shell quoting survives quotes, spaces and metacharacters', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote('with space'), "'with space'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
  assert.equal(shellQuote('a; rm -rf ~'), "'a; rm -rf ~'");
  assert.equal(shellQuote('back`tick`'), "'back`tick`'");
});

test('remote command composes bootstrap, cwd and argv safely', () => {
  const command = buildRemoteCommand(undefined, {
    cwd: '/workspaces/my repo',
    argv: ['cmdc', '-p', "explain; rm -rf /"],
  });

  assert.match(command, /NVM_DIR/);
  assert.ok(command.includes(`cd '/workspaces/my repo'`));
  assert.ok(command.includes(`'explain; rm -rf /'`));
  assert.ok(!command.includes('explain; rm -rf / '));
});

test('remote command falls back to a raw command string', () => {
  const command = buildRemoteCommand('node -v');
  assert.match(command, /node -v$/);
});

test('cmd shim quoting only quotes when the argument needs it', () => {
  assert.equal(quoteForCmdShim('plain'), 'plain');
  assert.equal(quoteForCmdShim('with space'), '"with space"');
  assert.equal(quoteForCmdShim('a&b'), '"a&b"');
  assert.equal(quoteForCmdShim('say "hi"'), '"say ""hi"""');
});

test('platform constant matches the runtime', () => {
  assert.equal(isWindows, process.platform === 'win32');
});
