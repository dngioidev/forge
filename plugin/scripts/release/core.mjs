/**
 * Release core (spec §4 item 7 + §2 git conventions) — pure functions:
 * conventional-commit parsing, bump derivation, changelog + release-body
 * rendering. No I/O here; the runner owns side effects.
 */
const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf'];
const COMMIT_RE = /^(\w+)(\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommit(subject) {
  const m = COMMIT_RE.exec(subject ?? '');
  if (!m || !TYPES.includes(m[1])) return null;
  const tickets = [...(m[5] ?? '').matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
  return {
    type: m[1],
    scope: m[3] ?? null,
    breaking: m[4] === '!',
    subject: m[5].trim(),
    tickets,
  };
}

/** fix→patch, feat→minor, breaking→major; highest wins. Null when nothing releasable. */
export function deriveBump(commits) {
  let bump = null;
  for (const c of commits) {
    const parsed = typeof c === 'string' ? parseCommit(c) : c;
    if (!parsed) continue;
    if (parsed.breaking || /BREAKING CHANGE/.test(parsed.body ?? '')) return 'major';
    if (parsed.type === 'feat' && bump !== 'major') bump = 'minor';
    else if (parsed.type === 'fix' && bump === null) bump = 'patch';
    else if (bump === null && TYPES.includes(parsed.type)) bump = 'patch'; // chore/docs/etc alone → patch
  }
  return bump;
}

export function nextVersion(current, bump) {
  if (!current) return '0.1.0';
  const [maj, min, pat] = current.replace(/^v/, '').split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const GROUP_TITLES = { feat: 'Features', fix: 'Fixes', perf: 'Performance', refactor: 'Refactoring', docs: 'Docs', test: 'Tests', chore: 'Chores' };

export function groupChanges(subjects) {
  const groups = {};
  for (const s of subjects) {
    const c = parseCommit(s);
    if (!c) continue;
    const key = GROUP_TITLES[c.type] ?? 'Other';
    (groups[key] ??= []).push(c);
  }
  return groups;
}

export function renderChangelogSection(version, date, groups, repoUrl) {
  const lines = [`## v${version} — ${date}`, ''];
  for (const [title, items] of Object.entries(groups)) {
    lines.push(`### ${title}`, '');
    for (const c of items) {
      const refs = c.tickets.map((t) => (repoUrl ? `[#${t}](${repoUrl}/issues/${t})` : `#${t}`)).join(' ');
      lines.push(`- ${c.subject}${c.breaking ? ' **[breaking]**' : ''}${refs ? ` (${refs})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Generated release-description shape (spec §2 git conventions). */
export function renderReleaseBody({ version, summary, groups, repoUrl, infraChanged, migrations, imageDigest }) {
  const lines = [summary, ''];
  for (const [title, items] of Object.entries(groups)) {
    lines.push(`### ${title}`, '');
    for (const c of items) {
      const refs = c.tickets.map((t) => (repoUrl ? `[#${t}](${repoUrl}/issues/${t})` : `#${t}`)).join(' ');
      lines.push(`- ${c.subject}${c.breaking ? ' **[breaking]**' : ''}${refs ? ` (${refs})` : ''}`);
    }
    lines.push('');
  }
  lines.push('### Deploy notes', '');
  lines.push(`- Infra changed: ${infraChanged ? '**yes** — review \`infra/\` diff before promoting' : 'no'}`);
  lines.push(`- Migrations to run: ${migrations ? '**yes**' : 'no'}`);
  if (imageDigest) lines.push(`- Image: \`${imageDigest}\` (retagged \`v${version}\` — the exact bytes staging verified)`);
  return lines.join('\n');
}

export function summarize(groups, version) {
  const counts = Object.entries(groups).map(([t, items]) => `${items.length} ${t.toLowerCase()}`).join(', ');
  return `v${version}: ${counts || 'maintenance release'}.`;
}
