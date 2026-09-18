import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_BOOTSTRAP } from './env.mjs';
import { execRemote } from './codespace.mjs';
import { run } from './proc.mjs';

// The CLI keeps its account token in ~/.commandcode/auth.json. A codespace has
// none, and `cmdc login` cannot complete there: it runs an OAuth callback server
// on the codespace's own localhost, which the browser on your laptop cannot
// reach. So the credential is carried over instead of re-created.
export function localAuthPath() {
  const override = process.env.CMDCS_AUTH_FILE;
  if (override) return override;
  return join(homedir(), '.commandcode', 'auth.json');
}

export function localAuthExists() {
  return existsSync(localAuthPath());
}

export function localAuthMtime() {
  try {
    return Math.floor(statSync(localAuthPath()).mtimeMs / 1000);
  } catch {
    return null;
  }
}

const REMOTE_AUTH = '$HOME/.commandcode/auth.json';

function remoteAuthStatCommand() {
  return `${REMOTE_BOOTSTRAP}; [ -f "${REMOTE_AUTH}" ] && stat -c %Y "${REMOTE_AUTH}" 2>/dev/null || echo missing`;
}

export async function remoteAuthMtime(codespace) {
  const result = await execRemote(codespace, remoteAuthStatCommand());
  const value = result.stdout.trim().split('\n').pop()?.trim();
  if (!value || value === 'missing') return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

export async function copyAuthToRemote(codespace, { quiet = false } = {}) {
  const source = localAuthPath();
  if (!existsSync(source)) {
    throw new Error(`No credentials at ${source}. Run: cmdc login`);
  }

  const notice = message => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  await execRemote(codespace, `${REMOTE_BOOTSTRAP}; mkdir -p "$HOME/.commandcode" && chmod 700 "$HOME/.commandcode"`);

  const copy = await run('gh', [
    'codespace',
    'cp',
    '-c',
    codespace.name,
    source,
    'remote:.commandcode/auth.json',
  ]);

  if (copy.code !== 0) {
    throw new Error(`Could not copy credentials: ${(copy.stderr || copy.stdout).trim()}`);
  }

  // gh cp does not carry the file mode across, and this file holds a live token.
  await execRemote(codespace, `${REMOTE_BOOTSTRAP}; chmod 600 "${REMOTE_AUTH}"`);
  notice(`Synced Command Code credentials into ${codespace.name}`);
}

// Copies only when the remote copy is missing or older than the local one, so a
// re-login on the laptop propagates on the next connect without a manual step.
export async function ensureRemoteAuth(codespace, { quiet = false, force = false } = {}) {
  const local = localAuthMtime();
  if (local === null) return { synced: false, reason: 'no-local-auth' };

  const remote = await remoteAuthMtime(codespace);
  if (!force && remote !== null && remote >= local) {
    return { synced: false, reason: 'up-to-date', remote };
  }

  await copyAuthToRemote(codespace, { quiet });
  return { synced: true, reason: remote === null ? 'missing-remote' : 'stale-remote' };
}
