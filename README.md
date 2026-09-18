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

## Driving the GUI app at a codespace (mod)

`mods/codespace.ts` points a **local GUI or CLI session** at the codespace filesystem. The app
keeps its own auth, session and UI; every file and shell operation is proxied into the codespace
over `gh codespace ssh`:

| Tool | Purpose |
| --- | --- |
| `cs_read` | Read a file (with line numbers) from the codespace |
| `cs_write` | Create or overwrite a file there |
| `cs_shell` | Run a shell command there |
| `cs_glob` | Find files by glob pattern |
| `cs_grep` | Search file contents |

```bash
# try it without installing
cmdc --mod ./mods/codespace.ts

# or install it for every session
cp mods/codespace.ts ~/.commandcode/mods/
```

With exactly one codespace it auto-detects the target. With several, pin one:

```json
// .commandcode/codespace.json
{ "codespace": "my-codespace-name" }
```

The mod also appends a system-prompt note naming the remote target, so the model does not reach
for the local filesystem tools on a repo that is not on this machine.

### Two hard-won implementation notes

Both were found by testing against a real codespace, and both would fail silently otherwise:

- **`cmd.exec` does not forward stdin.** A child process reading stdin receives zero bytes, so
  payloads cannot be piped. Everything travels inside the command line.
- **`cmd.exec` shell-quotes each argv element**, and `gh codespace ssh` re-parses the command on
  the remote side. A script containing quotes survives neither round trip, which produced
  `unexpected EOF while looking for matching '"'` on every call. The script is therefore
  **base64-encoded and decoded remotely** — base64 is `[A-Za-z0-9+/=]`, so no quoting layer can
  touch it, and the decoded script keeps its own quoting intact.

## What a codespace actually gives you

Measured on a throwaway `basicLinux32gb` codespace (2 cores), not taken from docs:

```
Filesystem      Size  Used Avail Use% Mounted on
overlay          32G   11G   19G  37% /
/dev/loop4       32G   11G   19G  37% /workspaces
/dev/sdb1        44G  3.3G   39G   8% /tmp
```

| Resource | Value |
| --- | --- |
| `/` and `/workspaces` | 32 GB total, **19 GB free** on a fresh container |
| `/tmp` | 44 GB total, **39 GB free** — a separate, larger volume |
| RAM | 7.8 GB (1.2 GB used at idle, 6.5 GB available) |
| CPU | 2 cores |
| Files (`/`, `/workspaces`) | 2,097,152 inodes total, **1,774,172 free** |
| Files (`/tmp`) | 2,949,120 inodes total, **2,944,955 free** |

So "how many files" has a real answer: about **1.77 million more files** before the inode table
runs out. In practice you hit the 19 GB byte limit long before the inode limit — a million small
source files is far less of a constraint than the total size of what you check out.

Node `v24.20.0` and npm `11.19.0` come with the image, so the CLI installs with no setup:
`npm install -g command-code` then `chmod +x` nothing — it just works.

That 19 GB is the working budget for the repo plus every dependency you install. If you need
more, `-m` picks a bigger machine type (the storage tier grows with the machine class).

## Known quirks found while building this

Two real bugs that only show up on Windows against a Linux codespace:

- **`gh codespace cp` cannot write to the remote on Windows.** It hands the remote path to
  `scp.exe` with literal single quotes embedded, so the remote reports
  `dest open "'.commandcode/auth.json'": No such file or directory`. Credentials are transferred
  as base64 over the SSH channel instead.
- **`gh codespace create` fails without `-m`.** Without a machine type it tries to prompt, which
  fails non-interactively: `error getting machine type: error getting machine: no terminal`.
  A default is always passed.

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
