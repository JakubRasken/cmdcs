# cmdcs

Run [Command Code](https://commandcode.ai) inside a GitHub Codespace, from any machine.

The codespace holds the repo, the toolchain, and the session state. Your laptop is just a
terminal — so the same environment follows you between Windows, macOS, and Linux devices.

```bash
cmdcs doctor          # is this machine ready?
cmdcs list            # what codespaces do I have?
cmdcs open            # drop into the Command Code TUI inside a codespace
```

## Why

Command Code itself is local-first: it reads and writes the filesystem it was started in.
A codespace is already a full remote dev environment with its own filesystem, so the clean
solution is to run the CLI *there* and treat the local machine as a thin client. No file
syncing, no mounted remote filesystems, no duplicated state.

## Requirements

| Requirement | Why | Install |
| --- | --- | --- |
| Node.js 18+ | runs this CLI | <https://nodejs.org> |
| GitHub CLI (`gh`), authenticated | talks to Codespaces | `winget install GitHub.cli` / `brew install gh` |
| `codespace` token scope | Codespaces API access | `gh auth refresh -h github.com -s codespace` |

`cmdcs doctor` checks all three and tells you exactly what is missing.

The `codespace` scope is the one people trip over — `gh auth login` does not request it by
default, so `gh codespace list` fails with `HTTP 403` until you refresh.

## Install

```bash
npm install -g cmdcs
```

Or run it straight from a clone:

```bash
node ./bin/cmdcs.mjs doctor
```

## Commands

| Command | Description |
| --- | --- |
| `cmdcs doctor` | Check local prerequisites and probe a codespace for node/npm/cmdc |
| `cmdcs login` | Grant the `codespace` scope to `gh` (one-time, interactive) |
| `cmdcs list` | List codespaces with state, repo, and machine type |
| `cmdcs create` | Create a codespace with explicit idle/retention guards |
| `cmdcs remove` | Delete a codespace and its remote filesystem |
| `cmdcs stop` | Stop a running codespace |
| `cmdcs open` | Open the Command Code TUI inside a codespace (installs the CLI first if needed) |
| `cmdcs run -- <cmd>` | Run a one-shot command inside a codespace; stdin is forwarded |
| `cmdcs ensure` | Install or update `command-code` inside a codespace (`--upgrade` to force) |
| `cmdcs status` | Report node/npm/cmdc inside a codespace |

### Common options

| Option | Description |
| --- | --- |
| `-c, --codespace <name>` | Codespace name, unique prefix, or repo match |
| `--cwd <path>` | Directory to run in, inside the codespace |
| `--json` | Machine-readable output (`list`, `status`) |
| `--skip-bootstrap` | Do not install/update Command Code before opening |
| `--no-start` | Never auto-start a stopped codespace |

### `create` options

| Option | Description |
| --- | --- |
| `-R, --repo <owner/name>` | Repository to host the codespace (required) |
| `-m, --machine <type>` | Hardware spec (default: repo's default machine) |
| `-b, --branch <branch>` | Branch to check out |
| `--idle <duration>` | Stop after inactivity (default `30m`) |
| `--retention <duration>` | Delete this long after shutdown (default `24h`) |

Idle timeout and retention are always passed explicitly, so a throwaway codespace expires on
its own even if you forget to delete it.

### Examples

```bash
# One-time: grant the codespace scope
cmdcs login

# A disposable codespace with a 24h reap window
cmdcs create --repo JakubRasken/cmdc-island --idle 30m --retention 24h

# Interactive session in a specific codespace
cmdcs open -c my-repo

# Pass Command Code flags through after `--`
cmdcs open -- --model claude-sonnet-4-5

# Headless question, answered inside the codespace
echo "explain the architecture of this repo" | cmdcs run -- cmdc -p

# Measure the remote filesystem
cmdcs run -- df -h /

# Clean up
cmdcs remove -c my-repo
```

## How it works

```
your machine                          codespace
  cmdcs ──── gh codespace ssh ────►   bash -lc
                                       ├── source nvm / fnm
                                       ├── export ~/.local/bin, /opt/homebrew/bin
                                       └── cmdc  (TUI, or -p for headless)
```

Three details make this work reliably across platforms:

**Login-shell bootstrap.** A non-interactive SSH command skips `.bashrc`, so `node` from
nvm/fnm/Homebrew is not on `PATH`. Every remote command is prefixed with a bootstrap snippet
that sources nvm and fnm and exports the usual bin directories. Without it, a codespace that
happily runs `node` in its terminal reports `node: command not found` over SSH.

**No shell on the local side.** `gh` is spawned directly with argv (never through a shell),
and `npm` runs through its JS entry point (`node .../npm-cli.js`) instead of the `.cmd` shim.
Node 18+ refuses to spawn `.cmd` files without a shell (`EINVAL`), and routing around the shim
avoids cmd.exe quoting rules entirely.

**Quoting at the remote boundary.** The remote command is passed as a single argv element to
`gh`, then quoted for bash inside the codespace. Codespace names, working directories, and
command arguments all go through `shellQuote`, so no argument can break out into a second
command.

## Authentication inside the codespace

Command Code keeps your account token in `~/.commandcode/auth.json`, and it uses your existing
plan — no API key needed. A fresh codespace has no credentials, and **`cmdc login` cannot
complete over SSH**: it starts an OAuth callback server on the codespace's own `localhost`,
which the browser running on your laptop cannot reach.

So `cmdcs` carries the credential over instead of re-creating it:

- `cmdcs open` and `cmdcs run` copy `~/.commandcode/auth.json` into the codespace
  (mode `0600`) before running anything.
- It only copies when the remote copy is **missing or older** than the local one — so
  re-logging-in on your laptop propagates on the next connect, with no manual step.
- The transfer goes over the SSH channel `gh codespace cp` already uses, into a codespace that
  is already yours.

That means the whole flow is: `cmdc login` once on your laptop, then `cmdcs open` anywhere.
Sign in on a second device and the codespace picks it up.

Skip it with `--no-auth`, or force a re-copy with `--sync-auth`.

> The token is a live credential. It lands in your own codespace, readable only by you, and
> stops existing when you `cmdcs remove` it.

### If you would rather not copy credentials

Use a **Codespaces user secret** and a BYOK provider instead (`cmdc login copilot`, or an API
key for a provider you already pay for). The secret is injected into the codespace environment,
and `~/.commandcode/providers.json` references it:

```json
{"provider": {"openrouter": {
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKey": "$OPENROUTER_API_KEY",
  "models": {"deepseek/deepseek-v4-flash": {}}
}}}
```

`apiKey` is a *reference* — `$VAR`, `{env:VAR}`, `!command`, or `false` — never the key itself,
so the file is safe in a dotfiles repo. Run with `--local-only` (`CMD_LOCAL_ONLY=1`) to send
nothing through Command Code's servers.

## Auto-start

A stopped codespace is started automatically and polled until its SSH daemon is reachable
(the state machine runs `Shutdown` → `Starting` → `Available`). Pass `--no-start` to fail
fast instead, or start it yourself:

```bash
gh codespace start -c my-repo
```

## Troubleshooting

**`HTTP 403: Must have admin rights to Repository` / `needs the "codespace" scope`**

Your `gh` token is missing the scope:

```bash
gh auth refresh -h github.com -s codespace
```

**`node: command not found` inside the codespace**

The bootstrap did not find a node installation. Check what the image provides:

```bash
cmdcs run -- 'ls -la /usr/local/share/nvm/versions/node || which -a node'
```

**The TUI misbehaves on Windows**

Old consoles do not deliver proper ANSI input events. Run `cmdcs open` from Windows Terminal
(with the app available), where the CLI renders correctly.

**Multiple codespaces match**

Pass `--codespace <name>`; `cmdcs list` shows the exact names.

## Development

```bash
npm test          # unit tests for parsing, quoting, and platform shims
npm run doctor    # self-check
```

The modules are deliberately small and single-purpose:

| File | Responsibility |
| --- | --- |
| `src/proc.mjs` | Cross-platform spawning, npm shim resolution, interactive stdio |
| `src/env.mjs` | Local prerequisites, remote probe, remote login-shell bootstrap |
| `src/gh.mjs` | `gh codespace` calls and codespace resolution |
| `src/codespace.mjs` | SSH execution, readiness/auto-start, TUI launch |

## Roadmap

`cmdcs` is Phase 1 of a larger plan: a **remote filesystem backend** for Command Code.

- **Phase 0** — verify the tunnel/SSH path works. Done, in this repo's `doctor`/`open`/`run`.
- **Phase 1** — this CLI: one command to run the agent inside a codespace from any device.
- **Phase 2** — a long-lived agent inside the codespace exposing file/shell tools over a
  forwarded port, so the *local* Command Code session works against the remote filesystem.
  Multi-device continuity comes from the agent living in the codespace.
- **Phase 3** — a Command Code mod (`/codespace` command, status widget, `setActiveTools` to
  swap the filesystem layer for remote-backed tools).
- **Phase 4** — generalize the target from Codespaces to any SSH host.
