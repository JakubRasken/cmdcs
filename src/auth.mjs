import { spawn } from 'node:child_process';

// `gh auth refresh -s codespace` needs an interactive TTY for its confirmation
// prompt, so it is spawned directly onto the user's terminal. Device-flow
// output lands there too, which is what the user needs to read.
export function loginWithCodespaceScope({ hostname = 'github.com' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      ['auth', 'refresh', '-h', hostname, '-s', 'codespace'],
      { stdio: 'inherit', windowsHide: false },
    );

    child.on('error', err => {
      reject(new Error(`Could not start gh: ${err.message}`));
    });

    child.on('close', code => {
      resolve({ code: code ?? 0 });
    });
  });
}

export function loginHint(hostname = 'github.com') {
  return `gh auth refresh -h ${hostname} -s codespace`;
}
