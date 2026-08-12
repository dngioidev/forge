# Plan: #426 - reconcile the stale self-hosted `runner` block against hosted-runner CI reality

**Ticket:** #426 (parent #182) - **Kind:** chore
**Base:** main - **Branch:** chore/426-runner-config-reconcile

Surfaced by #339 delivery / the full-branch review of PR #425: `.claude/forge.json`
declared `runner.enabled: true`, but `.github/workflows/verify.yml` runs every leg
on GitHub-hosted runners (this repo is public — hosted minutes are free/unlimited
and a self-hosted runner must never process untrusted fork PRs; ADR-0005 decision
3). The config block and the actual CI topology disagreed, which is a live
footgun for anything that reads `runner` to reason about CI (`forge:runner-check`,
`forge:doctor`'s runner-health line, a human reading the config).

Confirmed before the fix: `node plugin/scripts/doctor.mjs` on this repo reported
`✗ runner   runner.enabled on a PUBLIC repo — forks can run untrusted code on your
machine (fork-PR RCE)` — a real FAIL line, even though the runner block was never
wired into this repo's actual CI (`verify.yml` never references the `forge-local`
label). That is the misleading picture AC.2 targets.

Non-goal (explicit in the ticket): do not change where CI actually runs. The
hosted-runner posture is correct for a public repo; this only fixes config/docs
drift. `verify.yml`'s `runs-on` values are untouched.

## AC map

- **AC-426.1** `.claude/forge.json`'s `runner` block reflects reality for this
  public repo: `enabled: false` (the documented, safe default — off until
  explicitly enabled — per `RUNNER_DEFAULTS` in `plugin/scripts/lib/config.mjs`),
  with the rest of the block (`labels`/`sharing`/`windows`) left in place as the
  template a private fork would flip on (already documented as "Private
  repositories only" in `runner/README.md` and ADR-0005). No schema change
  needed: `enabled: false` is unambiguous and requires no new annotation field.
- **AC-426.2** `forge:doctor` and `forge:runner-check` (both built on the shared
  `plugin/scripts/lib/runner-checks.mjs`) report a coherent, non-misleading
  verdict once AC-426.1 lands: doctor is silent on `runner`/`runner-secret` (its
  existing "silent unless `runner.enabled`" behavior, `plugin/scripts/doctor.mjs`
  line ~200) — no more false FAIL — while `forge:runner-check`, whose job is an
  *adoption* preflight, still and correctly reports NOT READY (`runner-block`
  disabled + `private-repo` public — both true, not contradictory). Neither
  command's check logic needed to change; the fix is the config value itself.
  Pinned by a regression test in each command's suite that loads the ACTUAL
  committed `.claude/forge.json` (not a synthetic fixture) against a PUBLIC repo
  view matching this repo's real visibility.

## Task 1 (chore): flip the stale `runner.enabled` to match reality (AC-426.1)

`.claude/forge.json`: `runner.enabled` `true` → `false`. Labels/sharing/windows
left as-is (documents what a private-fork opt-in would use; matches
`RUNNER_DEFAULTS`). No code change — `normalizeRunner`/`validateConfig`
(`plugin/scripts/lib/config.mjs`) already treat `enabled:false` as the fully
valid, documented-safe shape.

**Files:** .claude/forge.json

## Task 2 (test): pin the coherent doctor/runner-check verdict (AC-426.1, AC-426.2)

`tests/doctor.test.mjs` — new case in the `runDoctor — runner health (AC-225.4)`
describe block: reads the live `.claude/forge.json`, asserts
`runner.enabled !== true` (regression pin against re-drifting), copies it
byte-for-byte into a tmp cwd, runs `runDoctor` against a PUBLIC repo view
(matching this repo's real visibility), and asserts zero `runner`/`runner-secret`
results and no `runner`-named entry in the failed set.

`tests/runner-check.test.mjs` — new case in the `runCheck — adoption readiness
(#245)` describe block: same live-config load + pin, run through `runCheck`
against a PUBLIC repo view + a scaffolded runner tree, asserting `ready:false`
for the honest reasons only (`runner-block` fail mentioning "disabled",
`private-repo` fail mentioning public/fork) — never a false READY for a config
that is both inactive and unsafe to enable on this repo.

**Files:** tests/doctor.test.mjs, tests/runner-check.test.mjs

## Verification

`pnpm verify` (full suite). Gates: plandrift clean (both **Files:** lists cover
every touched path), testintent clean (only new assertions added), depguard
clean (no new dependencies), ac-gate clean (AC-426.1 and AC-426.2 each covered
by ≥1 passing test). Manual before/after: `node plugin/scripts/doctor.mjs` and
`node plugin/scripts/runner/check.mjs` run directly against this repo, quoting
real output in the PR.
