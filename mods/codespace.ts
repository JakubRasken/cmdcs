// Command Code mod: point the agent at a GitHub Codespace filesystem.
//
// The local app keeps its own auth, session and UI, while every file and shell
// operation is proxied into the codespace over `gh codespace ssh`. A GUI session
// whose working tree is genuinely remote - no syncing, no second checkout.
//
// Install: copy to ~/.commandcode/mods/codespace.ts (picked up next session),
//          or run with --mod <path> to try it without installing.
// Config : .commandcode/codespace.json -> {"codespace": "<name>"}   (optional;
//          auto-detected when exactly one codespace exists)
//
// NOTE: cmd.exec does NOT forward stdin (verified empirically - a child reading
// stdin receives zero bytes), so every payload travels inside the command line.
// That is also why file content is base64-encoded rather than piped.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export default function (cmd) {
	const state = { name: null };

	const readSetting = () => {
		try {
			const file = join(cmd.cwd ?? process.cwd(), '.commandcode', 'codespace.json');
			return JSON.parse(readFileSync(file, 'utf8'))?.codespace ?? null;
		} catch {
			return null;
		}
	};

	const configuredName = () => process.env.CMDCS_CODESPACE ?? readSetting();

	async function resolveCodespace() {
		if (state.name) return state.name;

		const explicit = configuredName();
		if (explicit) {
			state.name = explicit;
			return explicit;
		}

		const listed = await cmd.exec({
			command: 'gh',
			args: ['codespace', 'list', '--json', 'name,state', '--limit', '30'],
		});
		if (listed.code !== 0) {
			throw new Error(
				`Could not list codespaces - is gh authenticated with the codespace scope?\n` +
					`Run: gh auth refresh -h github.com -s codespace\n${listed.stderr.trim()}`,
			);
		}

		let parsed = [];
		try {
			parsed = JSON.parse(listed.stdout || '[]');
		} catch {
			throw new Error('Could not parse `gh codespace list` output.');
		}

		if (parsed.length === 0) throw new Error('No codespaces found. Create one with: gh codespace create');
		if (parsed.length > 1) {
			const rows = parsed.map(cs => `  ${cs.name}  (${cs.state})`).join('\n');
			throw new Error(`Several codespaces exist - pin one in .commandcode/codespace.json:\n${rows}`);
		}

		state.name = parsed[0].name;
		return state.name;
	}

	const shq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

	// A devcontainer's node/npm live under nvm and are absent from the
	// non-interactive PATH that `gh codespace ssh` starts with.
	const BOOTSTRAP = [
		'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
		'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
		'[ -s /usr/local/share/nvm/nvm.sh ] && . /usr/local/share/nvm/nvm.sh >/dev/null 2>&1',
		'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/local/share/nvm/current/bin:$PATH"',
		'NPM_PREFIX="$(npm prefix -g 2>/dev/null)"; [ -n "$NPM_PREFIX" ] && export PATH="$NPM_PREFIX/bin:$PATH"',
	].join('; ');

	// Windows caps a command line near 32k, so a huge payload would fail there
	// before it ever reached the codespace.
	const MAX_PAYLOAD = 20_000;

	// The script is base64-encoded and decoded remotely on purpose. `cmd.exec`
	// shell-quotes each argv element, and `gh codespace ssh` re-parses the
	// command again on the remote side - a script containing quotes survives
	// neither round trip intact. base64 is [A-Za-z0-9+/=], so no layer can
	// mangle it, and the decoded script keeps its own quoting exactly.
	async function remote(script, { cwd } = {}) {
		const name = await resolveCodespace();
		const full = [BOOTSTRAP, cwd ? `cd ${shq(cwd)}` : null, script].filter(Boolean).join('\n');
		const encoded = Buffer.from(full, 'utf8').toString('base64');

		if (encoded.length > MAX_PAYLOAD) {
			throw new Error(
				`Encoded command is ${encoded.length} chars, over the ${MAX_PAYLOAD} limit imposed by the ` +
					`Windows command line. Split the work into smaller steps.`,
			);
		}

		const result = await cmd.exec({
			command: 'gh',
			args: [
				'codespace',
				'ssh',
				'-c',
				name,
				'--',
				`echo ${shq(encoded)} | base64 -d | bash`,
			],
		});

		if (result.code !== 0) {
			throw new Error((result.stderr || result.stdout).trim() || `Remote command failed (${result.code})`);
		}
		return prune(result.stdout);
	}

	// The remote login shell prints `declare -x` slop when a bootstrap statement
	// emits to stdout; strip the known noise so tool results stay readable.
	function prune(output) {
		if (!output.includes('declare -x ')) return output;
		return output
			.split('\n')
			.filter(line => !line.startsWith('declare -x '))
			.join('\n')
			.replace(/^\n+/, '');
	}

	function addTool({ name, description, properties, required, readOnly, run }) {
		cmd.addTool({
			schema: {
				name,
				description,
				input_schema: { type: 'object', properties: properties ?? {}, required: required ?? [] },
			},
			readOnly: Boolean(readOnly),
			run: async ({ input }) => {
				try {
					return { ok: true, content: [{ type: 'text', text: await run(input ?? {}) }] };
				} catch (error) {
					return { ok: false, error: error?.message ?? String(error) };
				}
			},
		});
	}

	const pathArg = { type: 'string', description: 'Absolute path inside the codespace' };
	const cwdArg = { type: 'string', description: 'Working directory inside the codespace' };

	addTool({
		name: 'cs_read',
		description: 'Read a file from the active GitHub Codespace (not the local disk).',
		properties: {
			path: { ...pathArg, description: 'Path, absolute or relative to cwd' },
			cwd: cwdArg,
			offset: { type: 'number', description: '1-indexed first line' },
			limit: { type: 'number', description: 'Max lines (default 2000)' },
		},
		required: ['path'],
		readOnly: true,
		run: async input => {
			const offset = Number(input.offset ?? 1);
			const limit = Number(input.limit ?? 2000);
			const text = await remote(
				`awk -v s=${offset} -v n=${limit} 'NR>=s && NR<s+n {printf "%6d\\t%s\\n", NR, $0} NR>=s+n {exit}' ${shq(input.path)}`,
				{ cwd: input.cwd },
			);
			return text.trim() ? text : `(no output - ${input.path} may be empty or missing)`;
		},
	});

	addTool({
		name: 'cs_write',
		description: 'Create or overwrite a file in the active GitHub Codespace.',
		properties: {
			path: { ...pathArg, description: 'Path, absolute or relative to cwd' },
			content: { type: 'string', description: 'Full file content' },
			cwd: cwdArg,
		},
		required: ['path', 'content'],
		run: async input => {
			const content = String(input.content ?? '');
			const payload = Buffer.from(content, 'utf8').toString('base64');

			if (payload.length > MAX_PAYLOAD) {
				throw new Error(
					`Payload is ${payload.length} base64 chars, over the ${MAX_PAYLOAD} limit imposed by the ` +
						`Windows command line. Write the file in smaller pieces, or use cs_shell with a heredoc.`,
				);
			}

			const out = await remote(
				`mkdir -p "$(dirname ${shq(input.path)})"; printf %s ${shq(payload)} | base64 -d > ${shq(input.path)}; wc -l < ${shq(input.path)}`,
				{ cwd: input.cwd },
			);
			return `Wrote ${input.path} (${out.trim()} lines)`;
		},
	});

	addTool({
		name: 'cs_shell',
		description: 'Run a shell command inside the active GitHub Codespace and return its output.',
		properties: { command: { type: 'string', description: 'Bash command' }, cwd: cwdArg },
		required: ['command'],
		run: async input => (await remote(input.command, { cwd: input.cwd })) || '(no output)',
	});

	addTool({
		name: 'cs_glob',
		description: 'Find files by glob pattern inside the active GitHub Codespace.',
		properties: { pattern: { type: 'string', description: 'e.g. src/**/*.ts' }, cwd: cwdArg },
		required: ['pattern'],
		readOnly: true,
		run: async input => {
			const out = await remote(
				`if command -v rg >/dev/null 2>&1; then rg --files -g ${shq(input.pattern)} | head -200; ` +
					`else find . -path ${shq(`*${input.pattern}*`)} -not -path '*/.git/*' | head -200; fi`,
				{ cwd: input.cwd },
			);
			return out || '(no matches)';
		},
	});

	addTool({
		name: 'cs_grep',
		description: 'Search file contents inside the active GitHub Codespace.',
		properties: {
			pattern: { type: 'string', description: 'Regex to search for' },
			path: { type: 'string', description: 'Directory or file to search (default .)' },
			cwd: cwdArg,
		},
		required: ['pattern'],
		readOnly: true,
		run: async input => {
			const scope = input.path ? shq(input.path) : '.';
			const out = await remote(
				`if command -v rg >/dev/null 2>&1; then rg -n --no-heading ${shq(input.pattern)} ${scope} | head -200; ` +
					`else grep -rn ${shq(input.pattern)} ${scope} 2>/dev/null | head -200; fi`,
				{ cwd: input.cwd },
			);
			return out || '(no matches)';
		},
	});

	// Seeing and switching the target from inside a session matters: without it
	// the only way to answer "what am I actually connected to?" is to guess.
	cmd.addCommand({
		name: 'codespace',
		description: 'Show or switch the codespace this session works against',
		argumentHint: '[name]',
		handler: async ({ args }) => {
			const wanted = (args ?? '').trim();

			if (!wanted) {
				const listed = await cmd.exec({
					command: 'gh',
					args: ['codespace', 'list', '--json', 'name,state,repository', '--limit', '30'],
				});
				if (listed.code !== 0) {
					return { message: `Could not list codespaces. Run: gh auth refresh -h github.com -s codespace` };
				}

				let parsed = [];
				try {
					parsed = JSON.parse(listed.stdout || '[]');
				} catch {
					return { message: 'Could not parse `gh codespace list` output.' };
				}
				if (parsed.length === 0) return { message: 'No codespaces yet. Create one with: cmdcs create --repo owner/name' };

				const active = configuredName() ?? (parsed.length === 1 ? parsed[0].name : null);
				const rows = parsed.map(cs => {
					const marker = cs.name === active ? '*' : ' ';
					return `${marker} ${cs.name}  [${cs.state}]  ${cs.repository}`;
				});

				return {
					message: [
						active ? `Active codespace: ${active}` : 'No codespace pinned - several exist, pick one.',
						'',
						...rows,
						'',
						'Switch with /codespace <name>',
					].join('\n'),
				};
			}

			state.name = wanted;
			return { message: `Codespace for this session set to ${wanted}.` };
		},
	});

	// Naming the target in the prompt is what keeps the model from reaching for
	// the local filesystem tools on a repo that is not on this machine.
	cmd.hooks({
		appendSystemPrompt: () => {
			const target = configuredName();
			return (
				'The cs_* tools (cs_read, cs_write, cs_shell, cs_glob, cs_grep) operate on a remote GitHub Codespace. ' +
				(target
					? `The active codespace is "${target}". `
					: 'The active codespace is auto-detected from `gh codespace list`. ') +
				'Use them for anything touching the project source in that codespace; the unprefixed ' +
				'read_file/write_file/grep/glob/shell_command tools still act on the LOCAL machine.'
			);
		},
	});
}
