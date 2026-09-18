import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isWindows, run, runChecked, runNpm } from './proc.mjs';

export const CMDC_BIN = isWindows ? 'cmdc.cmd' : 'cmdc';

// The command-code package declares engines.node >= 22, so a codespace on an
// older LTS cannot run the CLI even though `cmdc` installs fine.
export const MIN_NODE_MAJOR = 22;

// The npm package is `command-code` but all four of its binary aliases
// (cmd, cmdc, command-code, commandcode) resolve to the same dist/index.mjs.
// `cmd` is cmd.exe on Windows, so `cmdc` is the one name used everywhere here.
const CMDC_DIRS = isWindows
  ? [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm')]
  : ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin')];

export function findCmdc() {
  for (const dir of CMDC_DIRS) {
    const candidate = join(dir, CMDC_BIN);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Login shells on macOS start from a bare PATH, so node/nvm/brew must be
// re-sourced before the CLI script can run.
export const REMOTE_BOOTSTRAP = [
  'export NVM_DIR="$HOME/.nvm"',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
  'command -v fnm >/dev/null 2>&1 && eval "$(fnm env --shell bash)" 2>/dev/null',
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
  'NPM_PREFIX="$(npm prefix -g 2>/dev/null)"; [ -n "$NPM_PREFIX" ] && export PATH="$NPM_PREFIX/bin:$PATH"',
].join('; ');

export function probeRemote() {
  return `${REMOTE_BOOTSTRAP}; node -v 2>/dev/null; npm -v 2>/dev/null; command -v ${CMDC_BIN} || echo none`;
}

export function parseRemoteProbe(stdout) {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const node = lines.find(line => /^v\d+\.\d+\.\d+$/.test(line)) ?? null;
  const versions = lines.filter(line => /^\d+\.\d+\.\d+$/.test(line));
  const npm = versions[0] ?? null;
  const located = lines.find(line => line.includes('/') || line === 'none') ?? null;

  return { node, npm, cmdc: located === 'none' ? null : located };
}

export function nodeMajor(version) {
  const match = /^v(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : null;
}

export function nodeIsSupported(version) {
  const major = nodeMajor(version);
  return major !== null && major >= MIN_NODE_MAJOR;
}

// A global npm install lands in the npm prefix's bin dir, which is on PATH for
// an interactive login shell but NOT for the non-interactive command SSH runs
// without a tty. Resolving the prefix keeps the CLI reachable either way.
export function remoteCmdcPath() {
  return `"$(npm prefix -g 2>/dev/null)/bin/${CMDC_BIN}"`;
}

export async function ghVersion() {
  try {
    const { stdout } = await runChecked('gh', ['--version']);
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

export async function ghAuthScopes() {
  const result = await run('gh', ['auth', 'status']);
  const output = `${result.stdout}\n${result.stderr}`;

  if (/not logged in|no accounts/i.test(output)) {
    return { loggedIn: false, scopes: [] };
  }

  const match = output.match(/Token scopes:\s*(.+)/i);
  const scopes = match
    ? match[1]
        .split(',')
        .map(scope => scope.replace(/['"]/g, '').trim())
        .filter(Boolean)
    : [];

  return { loggedIn: /Logged in to/i.test(output), scopes };
}

export async function npmVersion() {
  try {
    const { stdout } = await runNpm(['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

export function hasCodespaceScope(scopes) {
  return scopes.includes('codespace');
}
