import { read as readJournal } from '../lib/journal.mjs';
import { deriveSituation } from '../lib/situation.mjs';

/**
 * Computed release-readiness checklist (spec §13) — forge:release refuses
 * unless every applicable item passes. Items whose feature is off skip with
 * an explicit note; degraded items (pre-SP5 AC map) are labeled degraded.
 */
export async function computeReadiness({ cwd, execFn, config, verifyCmd }) {
  const items = [];
  const pass = (name, msg) => items.push({ name, level: 'pass', msg });
  const skip = (name, msg) => items.push({ name, level: 'skip', msg });
  const failItem = (name, msg) => items.push({ name, level: 'fail', msg });

  const git = (...args) => execFn('git', args);

  // a release never cuts during an emergency (spec §7; SP10 T3)
  const situation = await deriveSituation(cwd);
  if (situation.key === 'incident' || situation.key === 'security-response') {
    failItem('situation', `situation is ${situation.key} — close it first (node plugin/scripts/care/incident.mjs)`);
  } else {
    pass('situation', situation.key);
  }

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.ok || branch.stdout.trim() !== 'main') failItem('branch', `releases cut from main only (on '${branch.stdout.trim()}')`);
  else pass('branch', 'on main');

  const dirty = await git('status', '--porcelain');
  if (!dirty.ok || dirty.stdout.trim() !== '') failItem('worktree', 'working tree not clean');
  else pass('worktree', 'clean');

  await git('fetch', 'origin', 'main', '--quiet');
  const behind = await git('rev-list', '--count', 'HEAD..origin/main');
  if (!behind.ok || Number(behind.stdout.trim()) > 0) failItem('sync', `behind origin/main by ${behind.stdout.trim() || '?'} commit(s)`);
  else pass('sync', 'up to date with origin/main');

  if (verifyCmd) {
    const [cmd, ...args] = verifyCmd.split(/\s+/);
    const verify = await execFn(cmd, args);
    if (!verify.ok) failItem('verify', `'${verifyCmd}' failed`);
    else pass('verify', `'${verifyCmd}' green`);
  } else {
    skip('verify', 'no verify command configured');
  }

  const journal = await readJournal(cwd, { kinds: ['review-finding'] });
  const criticals = journal.events.filter((e) => e.severity === 'critical' && e.resolved !== true);
  if (criticals.length) failItem('findings', `${criticals.length} open critical finding(s) in the journal`);
  else pass('findings', 'no open critical findings');

  items.push({ name: 'ac-gate', level: 'skip', msg: 'degraded until SP5 — AC map verified at ship time, not re-checked here' });

  if (config?.features?.deploy === true) {
    skip('staging-smoke', 'deploy repo — verify the staging smoke passed for the release SHA before promoting (mechanical check lands with workflow status API wiring)');
  } else {
    skip('staging-smoke', 'features.deploy off');
  }
  if (config?.features?.designReview === true) skip('visual-baselines', 'designReview repo — confirm baselines clean');
  else skip('visual-baselines', 'features.designReview off');

  return { ok: items.every((i) => i.level !== 'fail'), items };
}
