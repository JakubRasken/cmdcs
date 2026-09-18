import { run, runChecked, CommandError } from './proc.mjs';

// Field names must match `gh codespace list --json` exactly; gh rejects unknown
// ones outright rather than ignoring them. Valid: createdAt, displayName,
// gitStatus, lastUsedAt, machineName, name, owner, repository, state, vscsTarget.
const LIST_FIELDS = 'name,displayName,repository,state,machineName,gitStatus,lastUsedAt,createdAt';

export const SCOPE_HINT = 'gh auth refresh -h github.com -s codespace';

function scopeError(stderr = '') {
  if (/needs the "codespace" scope|x509|403/i.test(stderr)) {
    return new CommandError(
      `GitHub CLI is missing the "codespace" scope.\n  Fix: ${SCOPE_HINT}`,
      { stderr },
    );
  }
  return null;
}

export async function listCodespaces({ limit = 30 } = {}) {
  const result = await run('gh', ['codespace', 'list', '--json', LIST_FIELDS, '--limit', String(limit)]);
  if (result.code !== 0) {
    const scoped = scopeError(result.stderr);
    if (scoped) throw scoped;
    throw new CommandError(`gh codespace list failed (exit ${result.code})`, {
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return parseCodespaces(result.stdout);
}

export function parseCodespaces(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new CommandError('Could not parse `gh codespace list --json` output', { stdout });
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .map(entry => ({
      name: String(entry.name ?? ''),
      displayName: String(entry.displayName ?? entry.name ?? ''),
      repository: String(entry.repository ?? ''),
      state: String(entry.state ?? 'Unknown'),
      machine: String(entry.machineName ?? ''),
      lastUsedAt: entry.lastUsedAt ?? null,
      createdAt: entry.createdAt ?? null,
      gitStatus: entry.gitStatus ?? null,
    }))
    .filter(entry => entry.name.length > 0);
}

// A codespace must be Shutdown or Available before its SSH daemon exists.
export function isReady(codespace) {
  return /^(available|running)$/i.test(codespace.state);
}

export function isStopped(codespace) {
  return /^shutdown$/i.test(codespace.state);
}

export async function findCodespace(reference, options = {}) {
  const codespaces = await listCodespaces(options);
  if (codespaces.length === 0) {
    throw new CommandError('No codespaces found for this account.\n  Create one: gh codespace create');
  }

  if (!reference) {
    if (codespaces.length === 1) return codespaces[0];
    const ready = codespaces.filter(isReady);
    if (ready.length === 1) return ready[0];
    throw new CommandError(
      'Multiple codespaces found - pick one with --codespace <name>:\n' +
        codespaces.map(cs => `  ${cs.name}  (${cs.state})  ${cs.repository}`).join('\n'),
    );
  }

  const needle = reference.toLowerCase();
  const exact = codespaces.find(cs => cs.name.toLowerCase() === needle);
  if (exact) return exact;

  const partial = codespaces.filter(
    cs =>
      cs.name.toLowerCase().startsWith(needle) ||
      cs.displayName.toLowerCase().includes(needle) ||
      cs.repository.toLowerCase().includes(needle),
  );

  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new CommandError(
      `"${reference}" matches ${partial.length} codespaces - be more specific:\n` +
        partial.map(cs => `  ${cs.name}  (${cs.state})  ${cs.repository}`).join('\n'),
    );
  }

  throw new CommandError(`No codespace matching "${reference}".`);
}

export async function startCodespace(name) {
  return runChecked('gh', ['codespace', 'start', '-c', name]);
}

export async function stopCodespace(name) {
  return runChecked('gh', ['codespace', 'stop', '-c', name]);
}

export async function deleteCodespace(name) {
  return runChecked('gh', ['codespace', 'delete', '-c', name, '--force']);
}

// gh prompts for a machine type when one is not given, and that prompt fails
// without a terminal ("error getting machine type: error getting machine: no
// terminal"), so a default is always sent for non-interactive runs.
export const DEFAULT_MACHINE = 'basicLinux32gb';

// Idle timeout and retention are always set explicitly: a throwaway codespace
// that nobody remembers to delete should still expire on its own.
export async function createCodespace({
  repo,
  machine = DEFAULT_MACHINE,
  branch,
  displayName,
  idleTimeout = '30m',
  retentionPeriod = '24h',
} = {}) {
  const args = ['codespace', 'create', '--repo', repo, '--idle-timeout', idleTimeout, '--retention-period', retentionPeriod];
  if (machine) args.push('--machine', machine);
  if (branch) args.push('--branch', branch);
  if (displayName) args.push('--display-name', displayName);

  const result = await run('gh', args, { timeout: 600000 });
  if (result.code !== 0) {
    const scoped = scopeError(result.stderr);
    if (scoped) throw scoped;
    throw new CommandError(`gh codespace create failed (exit ${result.code})`, {
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  // gh prints the new codespace name; the last non-empty line is the name.
  const lines = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const name = lines[lines.length - 1] ?? '';

  return { name, stdout: result.stdout, stderr: result.stderr };
}
