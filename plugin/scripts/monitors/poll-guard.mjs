/**
 * Poll-failure guard (#318) — shared by the autopilot monitors so a *persistent*
 * poll failure (auth/network for CI, a real fs error for decisions) surfaces one
 * concise line to the running loop instead of being swallowed forever, while a
 * transient single/occasional failure stays silent.
 *
 * The old monitors wrapped each poll in `catch { /* transient *\/ }`, so a
 * standing failure silenced the watcher permanently and the loop never learned
 * CI/decision state. This tracks consecutive failures instead: reset on any good
 * poll, emit once the streak hits the threshold, then throttle so a lasting
 * outage does not spam every subsequent poll.
 */

/** Consecutive failed polls before the first error line is surfaced. */
export const FAILURE_THRESHOLD = 3;
/** While still failing, re-emit at most once per this many additional polls. */
export const REEMIT_EVERY = 10;

/** A fresh guard state. Kept opaque; carry it across ticks unchanged. */
export function freshGuard() {
  return { fails: 0, emittedAt: 0 };
}

/**
 * Fold one poll result into the guard. Pure — returns the next guard plus an
 * optional one-line error to print. `ok` is whether the poll observed a usable
 * state ("no PR yet" / "no decisions dir yet" count as ok, they are not errors).
 *
 * - ok:        reset the streak, stay silent.
 * - fail < N:  count it, stay silent (transient — never spam).
 * - fail == N: emit exactly one `<name> error: <reason> (N consecutive polls)`.
 * - fail > N:  silent until REEMIT_EVERY more failures elapse (one line per
 *              persistent episode, not per poll). Any ok resets everything.
 */
export function trackFailure(guard, ok, { name, reason } = {}) {
  if (ok) return { fails: 0, emittedAt: 0, line: null };
  const fails = guard.fails + 1;
  const due = guard.emittedAt === 0 || fails - guard.emittedAt >= REEMIT_EVERY;
  if (fails < FAILURE_THRESHOLD || !due) return { fails, emittedAt: guard.emittedAt, line: null };
  const why = String(reason ?? 'poll failed').split(/\r?\n/)[0].slice(0, 160);
  return { fails, emittedAt: fails, line: `${name} error: ${why} (${fails} consecutive polls)` };
}
