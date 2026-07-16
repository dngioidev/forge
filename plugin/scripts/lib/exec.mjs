import { spawn } from 'node:child_process';

/**
 * Windows-safe process runner. Always argv arrays, never a shell string —
 * untrusted content cannot become shell syntax (spec §13 anti-injection).
 *
 * The `.cmd`/`.bat` EINVAL lesson: Node refuses to spawn cmd scripts without
 * a shell (CVE-2024-27980 fix). We never pass shell:true with interpolated
 * strings; instead cmd scripts are routed through cmd.exe with an argv array.
 */
export function run(command, args = [], options = {}) {
  let cmd = command;
  let argv = args;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    cmd = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', command, ...args];
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { shell: false, windowsHide: true, ...options });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: String(err && err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

/**
 * gh CLI wrapper factory. The exec function is injectable so every consumer
 * (init, doctor) is testable with scripted responses instead of a live gh.
 */
export function makeGh(execFn = run) {
  return async function gh(args, { parseJson = false } = {}) {
    const res = await execFn('gh', args);
    if (parseJson && res.ok) {
      try {
        return { ...res, json: JSON.parse(res.stdout) };
      } catch {
        return { ...res, ok: false, json: null, stderr: `gh returned unparseable JSON for: gh ${args.join(' ')}` };
      }
    }
    return res;
  };
}
