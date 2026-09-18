import { CMDC_BIN, REMOTE_BOOTSTRAP } from './env.mjs';
import { run, runInteractive } from './proc.mjs';
import { isReady, startCodespace } from './gh.mjs';

// Codespaces run bash, so the remote command boundary quotes for bash and only
// passes it as a single argv element to `gh`.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteCommand(command, { cwd, argv } = {}) {
  const parts = [REMOTE_BOOTSTRAP];
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  if (Array.isArray(argv) && argv.length > 0) {
    parts.push(argv.map(shellQuote).join(' '));
  } else {
    parts.push(command);
  }
  return parts.join('; ');
}

export async function ensureReady(codespace, { autoStart = true, onNotice = () => {} } = {}) {
  if (isReady(codespace)) return codespace;

  if (!autoStart) {
    throw new Error(`Codespace ${codespace.name} is ${codespace.state}. Start it with: gh codespace start -c ${codespace.name}`);
  }

  onNotice(`Starting codespace ${codespace.name} (was ${codespace.state})...`);
  await startCodespace(codespace.name);

  let current = codespace;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (isReady(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 5000));
    const { listCodespaces } = await import('./gh.mjs');
    const codespaces = await listCodespaces();
    current = codespaces.find(cs => cs.name === codespace.name) ?? current;
    onNotice(`Waiting for ${codespace.name}... (${current.state})`);
  }

  throw new Error(`Codespace ${codespace.name} did not become available in time.`);
}

export async function execRemote(codespace, command, { cwd, argv, input, timeout } = {}) {
  const remote = buildRemoteCommand(command, { cwd, argv });
  const args = ['codespace', 'ssh', '-c', codespace.name, '--', remote];
  return run('gh', args, { input, timeout });
}

export async function execRemoteChecked(codespace, command, options = {}) {
  const result = await execRemote(codespace, command, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 6).join('\n');
    const error = new Error(detail || `Remote command failed (exit ${result.code})`);
    error.code = result.code;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

// Opens the remote Command Code TUI. stdio is inherited so the remote CLI owns
// the terminal directly - that is what keeps the TUI alive and correctly sized.
export async function openRemoteTui(codespace, { cwd, args = [] } = {}) {
  const cli = [CMDC_BIN, ...args.map(shellQuote)].join(' ');
  const remote = buildRemoteCommand(cli, { cwd });
  return runInteractive('gh', ['codespace', 'ssh', '-c', codespace.name, '--', remote]);
}
