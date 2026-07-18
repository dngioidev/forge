/**
 * forge-control spawner (C2/#62; spec §2). Builds the headless `claude -p`
 * invocation the runner supervises, and parses its result envelope. Flag shape
 * and envelope fields were verified live against Claude Code 2.1.207 (spec §12
 * spike): success → exit 0 + {subtype:'success', is_error:false}; failure →
 * exit 1 but STILL valid JSON on stdout with {is_error:true, terminal_reason}.
 * So the caller always parses stdout JSON and classifies from it + the exit code.
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** The exact verified argv (after the `claude` binary). Resume swaps the id flag. */
export function buildArgs({ brief, sessionId, repo, model = 'claude-sonnet-5', permissionMode = 'plan', resume = false } = {}) {
  const args = ['-p', brief ?? '', '--output-format', 'json', '--model', model, '--permission-mode', permissionMode];
  if (resume) args.push('-r', sessionId);
  else if (sessionId) args.push('--session-id', sessionId);
  if (repo) args.push('--add-dir', repo);
  return args;
}

/**
 * Terminal outcome from what actually happened. A supervisor-initiated kill wins
 * (killedReason = 'timeout' | 'killed'); otherwise the envelope decides. Bad/no
 * envelope with a non-zero exit is 'error'.
 */
export function classify({ exitCode, envelope, killedReason } = {}) {
  if (killedReason) return killedReason;
  if (envelope && envelope.is_error) return envelope.terminal_reason || 'api_error';
  if (exitCode === 0 && envelope && envelope.subtype === 'success') return 'success';
  return 'error';
}

/**
 * Spawn one headless session. Returns a handle immediately:
 *   { sessionId, pid, kill(), done }  where done resolves to
 *   { exitCode, envelope, stdout, stderr } once the process closes (incl. after kill).
 * spawnFn/cmd are injectable so the runner is testable without the real binary.
 */
export function spawnSession(opts = {}, { spawnFn = nodeSpawn, cmd = 'claude' } = {}) {
  const args = buildArgs(opts);
  const child = spawnFn(cmd, args, { cwd: opts.repo || process.cwd() });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d; });
  child.stderr?.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    const finish = (exitCode) => {
      let envelope = null;
      try { envelope = JSON.parse(stdout); } catch { /* non-JSON / partial → null, classify() → error */ }
      resolve({ exitCode, envelope, stdout, stderr });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (err) => { stderr += String(err); finish(-1); });
  });
  return { sessionId: opts.sessionId, pid: child.pid ?? null, kill: (sig = 'SIGTERM') => child.kill(sig), done };
}
