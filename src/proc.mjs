import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const isWindows = process.platform === 'win32';

// Node 18+ refuses to spawn .cmd/.bat without a shell (EINVAL), so shell shims
// are never used on Windows. npm ships a plain JS entry point beside the node
// binary, which needs no shell, no quoting layer, and no PATH lookup.
export function resolveNpm() {
  if (isWindows) {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return { bin: process.execPath, args: [cli] };
  }
  return null;
}

// Fallback for shim-only installs (nvm, fnm, Homebrew). Only used when the
// npm JS entry point is unavailable, and only with arguments we control.
export function quoteForCmdShim(value) {
  const text = String(value);
  if (!/[\s"&|<>^%()!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnConfig(bin, args, options) {
  const { cwd, env } = options;

  if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map(quoteForCmdShim).join(' ');
    return {
      bin: process.env.comspec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', line],
      options: { cwd, env, windowsHide: true },
    };
  }

  return { bin, args, options: { cwd, env, windowsHide: true } };
}

export class CommandError extends Error {
  constructor(message, { code, stdout, stderr, bin, args } = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.stdout = stdout ?? '';
    this.stderr = stderr ?? '';
    this.bin = bin;
    this.args = args ?? [];
  }
}

// Buffered execution. Arguments are passed as argv (no shell string) except for
// the documented .cmd shim fallback, which quoting is confined to.
export function run(bin, args = [], options = {}) {
  const { cwd, env, input, timeout } = options;
  const config = spawnConfig(bin, args, { cwd, env: env ? { ...process.env, ...env } : process.env });

  return new Promise((resolve, reject) => {
    const child = spawn(config.bin, config.args, {
      ...config.options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeout
      ? setTimeout(() => {
          child.kill();
          if (!settled) {
            settled = true;
            reject(new CommandError(`${bin} timed out after ${timeout}ms`, { bin, args }));
          }
        }, timeout)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', err => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new CommandError(`Failed to start ${bin}: ${err.message}`, { bin, args }));
    });

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export async function runChecked(bin, args = [], options = {}) {
  const result = await run(bin, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 4).join('\n');
    throw new CommandError(`${bin} ${args.join(' ')} exited ${result.code}`, {
      ...result,
      bin,
      args,
      message: detail,
    });
  }
  return result;
}

// npm runs through its JS entry point when present, so no shell shim is needed.
export async function runNpm(args = [], options = {}) {
  const resolved = resolveNpm();
  if (resolved) {
    return run(resolved.bin, [...resolved.args, ...args], options);
  }
  return run(isWindows ? 'npm.cmd' : 'npm', args, options);
}

// Interactive execution. `stdio: 'inherit'` is what makes a TUI work on macOS,
// where the child shares the terminal directly. Windows needs extra handling
// and that lives in the caller (ssh is run through a pty there).
export function runInteractive(bin, args = [], options = {}) {
  const { cwd, env } = options;
  const config = spawnConfig(bin, args, { cwd, env: env ? { ...process.env, ...env } : process.env });

  return new Promise((resolve, reject) => {
    const child = spawn(config.bin, config.args, {
      ...config.options,
      stdio: 'inherit',
      windowsHide: false,
    });

    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 0 }));
  });
}

export { isWindows };
