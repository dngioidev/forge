/**
 * Branch-name conventions (spec §2 git conventions).
 * Work branches:  <type>/<issue#>-<kebab-slug>            e.g. feat/15-button
 * Agent children: <work-branch>--<role>                   e.g. feat/15-button--implementer
 * Spikes:         spike/<issue#>-<slug>   (never merge)
 * Hotfix:         hotfix/<issue#>-<slug>  (incident-exempt in situation gating)
 * Environment branches come from deploy.environments; main is main.
 */
const WORK_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf', 'spike', 'hotfix'];
// slug = alnum runs joined by single hyphens, so `--` can never be part of a
// slug and always delimits the agent-child role suffix
const BRANCH_RE = new RegExp(`^(${WORK_TYPES.join('|')})/(\\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)(?:--([a-z][a-z-]*))?$`);

export function parseBranch(name, { environments = ['staging', 'production'] } = {}) {
  if (typeof name !== 'string' || name.length === 0 || name === 'HEAD') {
    return { kind: 'unknown', ticket: null };
  }
  if (name === 'main') return { kind: 'main', ticket: null };
  if (environments.includes(name)) return { kind: 'env', env: name, ticket: null };

  const m = BRANCH_RE.exec(name);
  if (!m) return { kind: 'unknown', ticket: null };
  const [, type, num, slug, role] = m;
  return {
    kind: type === 'spike' ? 'spike' : type === 'hotfix' ? 'hotfix' : 'work',
    type,
    ticket: Number(num),
    slug,
    role: role ?? null,
    isAgentChild: role != null,
  };
}
