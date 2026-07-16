import { run } from '../lib/exec.mjs';

/**
 * agy (Gemini CLI) adapter — implements the one adapter contract (spec §5):
 * declare defaults/models, map model-id→flags, run one prompt, return stdout.
 * Generalizes the agy-consult pattern. Repo context costs zero prompt tokens:
 * agy reads GEMINI.md natively (backends sync maintains the managed block).
 */
export const agyAdapter = {
  id: 'agy',
  defaultModel: 'gemini-flash',
  models: {
    'gemini-flash': ['-m', 'gemini-2.5-flash'],
    'gemini-pro': ['-m', 'gemini-2.5-pro'],
  },

  async available(execFn = run) {
    const res = await execFn('agy', ['--version']);
    return res.ok;
  },

  buildArgs(model) {
    const m = model ?? this.defaultModel;
    const flags = this.models[m];
    if (!flags) return { ok: false, error: `agy: unknown model id '${m}' — accepted: ${Object.keys(this.models).join(', ')}` };
    return { ok: true, args: [...flags, '-p'] };
  },

  /** run(prompt, model) → { ok, output | error } */
  async runPrompt(prompt, model, { execFn = run, timeoutMs = 600_000, cwd } = {}) {
    const built = this.buildArgs(model);
    if (!built.ok) return built;
    const res = await Promise.race([
      execFn('agy', [...built.args, prompt], { cwd }),
      new Promise((r) => setTimeout(() => r({ ok: false, code: -1, stdout: '', stderr: `agy timed out after ${timeoutMs}ms` }), timeoutMs)),
    ]);
    if (!res.ok) return { ok: false, error: res.stderr || `agy exited ${res.code}` };
    return { ok: true, output: res.stdout };
  },
};

export const ADAPTERS = { agy: agyAdapter };
