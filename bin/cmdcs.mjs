import { run, isWindows } from '../src/proc.mjs';
import {
  MIN_NODE_MAJOR,
  findCmdc,
  ghAuthScopes,
  ghVersion,
  hasCodespaceScope,
  nodeIsSupported,
  npmVersion,
  parseRemoteProbe,
  probeRemote,
} from '../src/env.mjs';
import { SCOPE_HINT, createCodespace, deleteCodespace, findCodespace, listCodespaces, stopCodespace } from '../src/gh.mjs';
import { execRemote, ensureReady, openRemoteTui } from '../src/codespace.mjs';
import { ensureRemoteAuth, localAuthExists, localAuthMtime, localAuthPath, remoteAuthMtime } from '../src/credentials.mjs';
import { loginWithCodespaceScope } from '../src/auth.mjs';

const VERSION = '0.1.0';

const HELP = `cmdcs ${VERSION} - run Command Code inside GitHub Codespaces from any machine

USAGE
  cmdcs <command> [options]

COMMANDS
  doctor              Check this machine and (optionally) a codespace for readiness
  login               Grant the "codespace" scope to the GitHub CLI (one-time, interactive)
  list                List your codespaces
  create              Create a codespace (requires --repo owner/name)
  remove              Delete a codespace and its remote filesystem
  stop                Stop a running codespace
  open [-- args...]   Open the Command Code TUI inside a codespace
  run -- <cmd|argv>   Run a command inside a codespace (stdin is forwarded)
  ensure              Install or update Command Code inside a codespace
  status              Probe node/npm/cmdc inside a codespace
  help                Show this message

OPTIONS
  -c, --codespace <name>   Codespace name, prefix, or repo match
      --cwd <path>         Directory to run in, inside the codespace
      --json               Machine-readable output (list, status)
      --skip-bootstrap     Do not install/update Command Code before opening
      --no-start           Never auto-start a stopped codespace

CREATE OPTIONS
  -R, --repo <owner/name>  Repository to host the codespace (required)
  -m, --machine <type>     Hardware spec, e.g. basicLinux32gb (default: repo default)
  -b, --branch <branch>    Branch to check out
      --idle <duration>    Stop after inactivity (default 30m)
      --retention <dur>    Delete this long after shutdown (default 24h)

EXAMPLES
  cmdcs doctor
  cmdcs login
  cmdcs create --repo owner/name --idle 30m --retention 24h
  cmdcs open
  cmdcs open -c my-repo -- --model claude-sonnet-4-5
  echo "explain this repo" | cmdcs run -- cmdc -p
  cmdcs run -- df -h /
  cmdcs remove -c my-repo
`;

function parseArgs(argv) {
  const flags = {
    codespace: null,
    cwd: null,
    json: false,
    bootstrap: true,
    start: true,
    repo: null,
    machine: null,
    branch: null,
    idle: '30m',
    retention: '24h',
    auth: true,
    syncAuth: false,
    rest: [],
  };
  let i = 0;

  const valueFlags = {
    '-c': ['codespace'],
    '--codespace': ['codespace'],
    '--cwd': ['cwd'],
    '--repo': ['repo'],
    '-R': ['repo'],
    '-m': ['machine'],
    '--machine': ['machine'],
    '-b': ['branch'],
    '--branch': ['branch'],
    '--idle': ['idle'],
    '--retention': ['retention'],
  };

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      flags.rest.push(...argv.slice(i + 1));
      break;
    }
    if (valueFlags[arg]) {
      for (const key of valueFlags[arg]) flags[key] = argv[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (arg === '--json') {
      flags.json = true;
      i += 1;
      continue;
    }
    if (arg === '--skip-bootstrap') {
      flags.bootstrap = false;
      i += 1;
      continue;
    }
    if (arg === '--no-start') {
      flags.start = false;
      i += 1;
      continue;
    }
    if (arg === '--no-auth') {
      flags.auth = false;
      i += 1;
      continue;
    }
    if (arg === '--sync-auth') {
      flags.syncAuth = true;
      i += 1;
      continue;
    }
    flags.rest.push(arg);
    i += 1;
  }

  return flags;
}

function line(label, value) {
  process.stdout.write(`${label.padEnd(22)}${value}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return undefined;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > 0 ? text : undefined;
}

async function resolveTarget(flags, { quiet = false } = {}) {
  const notice = message => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };
  const codespace = await findCodespace(flags.codespace);
  return ensureReady(codespace, { autoStart: flags.start, onNotice: notice });
}

async function commandDoctor(flags) {
  const problems = [];
  const fixes = [];

  process.stdout.write(`cmdcs doctor (${process.platform}/${process.arch})\n\n`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line('node', `${process.version}${nodeMajor >= 18 ? '' : `  <- cmdcs needs >= 18, the CLI needs >= ${MIN_NODE_MAJOR}`}`);
  if (nodeMajor < 18) problems.push('node is too old for cmdcs (need >= 18)');
  else if (nodeMajor < MIN_NODE_MAJOR) {
    problems.push(`node ${process.version} is too old for the Command Code CLI (needs >= ${MIN_NODE_MAJOR})`);
  }

  const gh = await ghVersion();
  line('gh', gh ?? 'MISSING');
  if (!gh) {
    problems.push('GitHub CLI not found');
    fixes.push('Install gh: https://cli.github.com  (winget install GitHub.cli | brew install gh)');
  }

  const { loggedIn, scopes } = await ghAuthScopes();
  line('gh auth', loggedIn ? `logged in (${scopes.length} scopes)` : 'not logged in');
  if (!loggedIn) {
    problems.push('gh is not authenticated');
    fixes.push('Run: gh auth login');
  } else if (!hasCodespaceScope(scopes)) {
    line('codespace scope', 'MISSING');
    problems.push('gh token lacks the "codespace" scope');
    fixes.push(`Run: ${SCOPE_HINT}`);
  } else {
    line('codespace scope', 'ok');
  }

  const npm = await npmVersion();
  line('npm', npm ?? 'MISSING');

  const localCmd = findCmdc();
  line('local cmdc', localCmd ?? 'not found (installed per-machine, not needed to drive a codespace)');

  if (localAuthExists()) {
    line('local credentials', localAuthPath());
  } else {
    line('local credentials', `MISSING at ${localAuthPath()}`);
    problems.push('no local Command Code credentials to carry into a codespace');
    fixes.push('Run: cmdc login');
  }

  if (isWindows) {
    line('terminal', 'Windows console - if the TUI misbehaves, run cmdcs from Windows Terminal');
  }

  if (loggedIn && hasCodespaceScope(scopes)) {
    process.stdout.write('\ncodespaces\n');
    try {
      const codespaces = await listCodespaces();
      if (codespaces.length === 0) {
        line('  found', 'none - create one with: gh codespace create');
      }
      for (const cs of codespaces) {
        line(`  ${cs.name}`, `${cs.state}  ${cs.repository}`);
      }
    } catch (error) {
      problems.push(`gh codespace list failed: ${error.message}`);
    }
  }

  if (flags.codespace || (problems.length === 0 && process.stdout.isTTY)) {
    try {
      const target = await resolveTarget(flags, { quiet: true });
      process.stdout.write(`\nremote probe: ${target.name}\n`);
      const result = await execRemote(target, probeRemote());
      const parsed = parseRemoteProbe(result.stdout);
      line('  node', `${parsed.node ?? 'MISSING'}${parsed.node && !nodeIsSupported(parsed.node) ? `  <- CLI needs >= ${MIN_NODE_MAJOR}` : ''}`);
      line('  npm', parsed.npm ?? 'MISSING');
      line('  cmdc', parsed.cmdc ?? 'not installed (cmdcs ensure)');
      if (parsed.node && !nodeIsSupported(parsed.node)) {
        problems.push(`codespace node ${parsed.node} is below the CLI's required >= ${MIN_NODE_MAJOR}`);
        fixes.push('Upgrade node in the codespace (nvm install 22, or pick a newer devcontainer image)');
      }
      if (!parsed.cmdc) {
        fixes.push('Run: cmdcs ensure -c ' + target.name);
      }

      const remoteAuth = await remoteAuthMtime(target);
      if (remoteAuth === null) {
        line('  credentials', 'not synced (cmdcs open will copy them)');
      } else {
        const local = Math.floor((localAuthMtime() ?? 0));
        line(
          '  credentials',
          remoteAuth >= local ? 'synced' : 'behind local - cmdcs open will refresh',
        );
      }
    } catch (error) {
      problems.push(`remote probe failed: ${error.message}`);
    }
  }

  process.stdout.write('\n');
  if (problems.length === 0) {
    process.stdout.write('All checks passed. Try: cmdcs open\n');
    return 0;
  }

  process.stdout.write('Problems:\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  if (fixes.length > 0) {
    process.stdout.write('\nNext steps:\n');
    for (const fix of fixes) process.stdout.write(`  - ${fix}\n`);
  }
  return 1;
}

async function commandCreate(flags) {
  const repo = flags.repo;
  if (!repo || !repo.includes('/')) {
    process.stderr.write('Need a repository.\nUsage: cmdcs create --repo owner/name [-m machine] [--idle 30m] [--retention 24h]\n');
    return 2;
  }

  process.stdout.write(`Creating a codespace for ${repo} (idle ${flags.idle}, retention ${flags.retention})...\n`);
  const { name } = await createCodespace({
    repo,
    machine: flags.machine,
    branch: flags.branch,
    idleTimeout: flags.idle,
    retentionPeriod: flags.retention,
  });

  if (!name) {
    process.stderr.write('Created, but could not read the codespace name from gh output. Run: cmdcs list\n');
    return 1;
  }

  process.stdout.write(`Created ${name}\n`);
  process.stdout.write(`It will stop after ${flags.idle} idle and be deleted ${flags.retention} after shutdown.\n`);
  return 0;
}

async function commandRemove(flags) {
  const target = await findCodespace(flags.codespace);
  process.stdout.write(`Deleting ${target.name} (${target.repository})...\n`);
  await deleteCodespace(target.name);
  process.stdout.write(`Deleted ${target.name}. The remote filesystem is gone.\n`);
  return 0;
}

async function commandStop(flags) {
  const target = await findCodespace(flags.codespace);
  await stopCodespace(target.name);
  process.stdout.write(`Stopped ${target.name}.\n`);
  return 0;
}

async function commandLogin(flags) {
  const { loggedIn, scopes } = await ghAuthScopes();

  if (!loggedIn) {
    process.stderr.write('gh is not authenticated.\nRun: gh auth login\n');
    return 1;
  }

  if (hasCodespaceScope(scopes)) {
    process.stdout.write('The codespace scope is already granted. Nothing to do.\n');
    return 0;
  }

  process.stdout.write('Requesting the "codespace" scope. Approve it in your browser:\n\n');
  const { code } = await loginWithCodespaceScope();
  if (code !== 0) {
    process.stderr.write(`\ngh auth refresh exited ${code}. Run it manually: ${SCOPE_HINT}\n`);
    return code;
  }

  const after = await ghAuthScopes();
  if (!hasCodespaceScope(after.scopes)) {
    process.stderr.write('\nScope still missing after refresh. Try: gh auth logout && gh auth login\n');
    return 1;
  }

  process.stdout.write('\ncodespace scope granted.\n');
  return commandList(flags);
}

async function commandList(flags) {
  const codespaces = await listCodespaces();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(codespaces, null, 2)}\n`);
    return 0;
  }
  if (codespaces.length === 0) {
    process.stdout.write('No codespaces. Create one with: gh codespace create\n');
    return 0;
  }
  for (const cs of codespaces) {
    process.stdout.write(`${cs.name}\n  state: ${cs.state}\n  repo:  ${cs.repository}\n`);
  }
  return 0;
}

async function commandStatus(flags) {
  const target = await resolveTarget(flags, { quiet: true });
  const result = await execRemote(target, probeRemote());
  const parsed = parseRemoteProbe(result.stdout);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ codespace: target.name, ...parsed }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${target.name} (${target.state})\n`);
  line('  node', parsed.node ?? 'MISSING');
  line('  npm', parsed.npm ?? 'MISSING');
  line('  cmdc', parsed.cmdc ?? 'not installed');
  return parsed.cmdc ? 0 : 1;
}

async function installRemote(target, { upgrade = false } = {}) {
  const probe = parseRemoteProbe((await execRemote(target, probeRemote())).stdout);

  if (probe.cmdc && !upgrade) {
    const version = (await execRemote(target, `${probe.cmdc} --version`)).stdout.trim().split('\n').pop();
    return { installed: false, cmdc: probe.cmdc, version };
  }

  process.stdout.write(`Installing command-code into ${target.name}...\n`);
  const install = await execRemote(target, 'npm install -g command-code', { timeout: 300000 });
  if (install.code !== 0) {
    process.stderr.write(install.stderr || install.stdout || 'Install failed.\n');
    process.stderr.write('\nInstall failed. Check npm network access inside the codespace.\n');
    return { installed: false, cmdc: null, version: null, code: install.code };
  }

  const verify = parseRemoteProbe((await execRemote(target, probeRemote())).stdout);
  if (!verify.cmdc) {
    process.stderr.write('Install reported success but cmdc is still not on PATH.\n');
    return { installed: false, cmdc: null, version: null, code: 1 };
  }

  const version = (await execRemote(target, `${verify.cmdc} --version`)).stdout.trim().split('\n').pop();
  return { installed: true, cmdc: verify.cmdc, version };
}

async function commandEnsure(flags) {
  const target = await resolveTarget(flags, { quiet: true });
  const result = await installRemote(target, { upgrade: flags.rest.includes('--upgrade') });

  if (result.code) return result.code;

  if (result.installed) {
    process.stdout.write(`Installed ${result.version} at ${result.cmdc}\n`);
  } else {
    process.stdout.write(`Already installed: ${result.version} at ${result.cmdc}\n`);
    process.stdout.write('Pass --upgrade to update it.\n');
  }
  return 0;
}

async function commandOpen(flags) {
  const target = await resolveTarget(flags, { quiet: true });

  if (flags.bootstrap) {
    const result = await installRemote(target);
    if (!result.cmdc) return result.code ?? 1;
  }

  if (flags.auth) {
    await ensureRemoteAuth(target, { force: flags.syncAuth });
  }

  process.stdout.write(`Opening Command Code in ${target.name}...\n`);
  const { code } = await openRemoteTui(target, { cwd: flags.cwd, args: flags.rest });
  return code;
}

// stdin has two jobs and they are mutually exclusive: with an explicit command
// it is forwarded as data; without one it IS the command (and only then do we
// also forward it so `echo hi | cmdcs run` reaches the remote shell's stdin).
async function commandRun(flags) {
  const target = await resolveTarget(flags, { quiet: true });
  const argv = flags.rest;
  const input = await readStdin();

  if (argv.length === 0 && input === undefined) {
    process.stderr.write('Nothing to run. Use: cmdcs run -- <command>\n');
    return 2;
  }

  if (flags.auth) {
    await ensureRemoteAuth(target, { quiet: true });
  }

  const command = argv.length <= 1 ? (argv[0] ?? input) : undefined;
  const passthrough = argv.length > 1 ? argv : undefined;

  const result = await execRemote(target, command, {
    cwd: flags.cwd,
    argv: passthrough,
    input,
    timeout: 600000,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code ?? 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags = parseArgs(command === 'help' ? [] : argv.slice(1));

  switch (command) {
    case 'doctor':
      return commandDoctor(flags);
    case 'login':
    case 'auth':
      return commandLogin(flags);
    case 'list':
    case 'ls':
      return commandList(flags);
    case 'create':
      return commandCreate(flags);
    case 'remove':
    case 'rm':
    case 'delete':
      return commandRemove(flags);
    case 'stop':
      return commandStop(flags);
    case 'status':
      return commandStatus(flags);
    case 'ensure':
      return commandEnsure(flags);
    case 'open':
    case 'attach':
      return commandOpen(flags);
    case 'run':
    case 'exec':
      return commandRun(flags);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then(code => {
    process.exitCode = code ?? 0;
  })
  .catch(error => {
    process.stderr.write(`\n${error.message}\n`);
    if (process.env.CMDCS_DEBUG) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
