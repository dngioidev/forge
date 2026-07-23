#!/usr/bin/env node
/**
 * forge local runner supervisor (ADR-0005 decisions 1 + 3).
 *
 * Steady state = JIT + `--ephemeral`. For each free worker slot this loops:
 *   1. mint a one-hour just-in-time runner config for one job
 *      (POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig), and
 *   2. run a single-use `docker compose run --rm` container that consumes it.
 * No runner credential outlives a job; a leaked JIT config self-expires in 1h.
 *
 * SECRET HANDLING (critical): the Administration-only PAT is read ONLY from this
 * process's own environment (FORGE_RUNNER_PAT), which the runner *service* loads
 * from the gitignored, chmod-600 ~/.forge/runner.env (systemd EnvironmentFile).
 * The supervisor:
 *   - passes it to `gh` via the child process env (GH_TOKEN), never on argv
 *     (argv is world-readable via /proc/<pid>/cmdline);
 *   - passes it to NOTHING else — the container only ever sees the JIT config;
 *   - never logs it or the minted JIT config.
 * Run this process under the service account, not an interactive shell, so the
 * token never lands in an ambient shell environment.
 *
 * Zero runtime deps (forge zero-dependency principle). Requires `gh` + Docker on
 * PATH. This is a scaffolded operational asset — enable it per runner/README.md.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = process.env.FORGE_RUNNER_OWNER || 'dngioidev';
const REPO = process.env.FORGE_RUNNER_REPO || 'forge';
const LABEL = process.env.FORGE_RUNNER_LABEL || 'forge-local';
const MAX_CONCURRENCY = Math.max(1, Number(process.env.FORGE_RUNNER_CONCURRENCY || '1'));
const COMPOSE_DIR = dirname(fileURLToPath(import.meta.url));
const PAT = process.env.FORGE_RUNNER_PAT;

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log(`received ${sig} — draining, no new jobs will start`); });
}

function log(msg) {
  // Never interpolate PAT / JIT config into a log line.
  process.stdout.write(`[forge-runner ${new Date().toISOString()}] ${msg}\n`);
}

/** Run a command, capturing stdout. Extra env is merged into the child only. */
function exec(cmd, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: COMPOSE_DIR,
      env: { ...process.env, ...env },
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let out = '';
    if (capture) child.stdout.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout: '', error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: out }));
  });
}

/**
 * Mint a single-use JIT config for one job. The PAT is handed to gh via env
 * (GH_TOKEN), never on the command line. Returns the encoded JIT config string.
 */
async function mintJitConfig() {
  const name = `forge-local-${randomUUID().slice(0, 8)}`;
  const res = await exec('gh', [
    'api', '-X', 'POST', `/repos/${OWNER}/${REPO}/actions/runners/generate-jitconfig`,
    '-f', `name=${name}`,
    '-F', 'runner_group_id=1',
    '-f', 'labels[]=self-hosted', '-f', 'labels[]=linux', '-f', `labels[]=${LABEL}`,
    '-f', 'work_folder=_work',
    '--jq', '.encoded_jit_config',
  ], { env: { GH_TOKEN: PAT }, capture: true });
  if (!res.ok) return { ok: false, error: `generate-jitconfig failed (exit ${res.code})` };
  const jit = res.stdout.trim();
  if (!jit) return { ok: false, error: 'generate-jitconfig returned no encoded_jit_config' };
  return { ok: true, jit, name };
}

/** Run exactly one job in a fresh ephemeral container, then tear it down. */
async function runOneJob() {
  const minted = await mintJitConfig();
  if (!minted.ok) { log(`mint failed: ${minted.error}`); return false; }
  log(`minted JIT config for ${minted.name} — starting ephemeral container`);
  const res = await exec('docker', ['compose', 'run', '--rm', 'runner'], {
    env: { ENCODED_JIT_CONFIG: minted.jit },
  });
  log(`container for ${minted.name} exited (code ${res.code})`);
  return true;
}

/** One worker slot: keep taking single jobs until asked to stop. */
async function worker(slot) {
  while (!stopping) {
    const ok = await runOneJob();
    if (!ok) await new Promise((r) => setTimeout(r, 10_000)); // back off on mint failure
  }
  log(`worker ${slot} drained`);
}

async function main() {
  if (!PAT) {
    log('FORGE_RUNNER_PAT is not set — load it from ~/.forge/runner.env into the service environment (see runner/README.md). Refusing to start.');
    process.exit(1);
  }
  if (OWNER.startsWith('{{') || REPO.startsWith('{{')) {
    log('owner/repo not substituted — re-run forge:init --runner in the target repo.');
    process.exit(1);
  }
  log(`supervising ${OWNER}/${REPO} on label "${LABEL}", concurrency ${MAX_CONCURRENCY}`);
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, (_, i) => worker(i + 1)));
  log('all workers drained — exiting');
}

main().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
