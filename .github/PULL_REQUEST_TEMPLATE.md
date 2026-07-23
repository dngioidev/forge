<!--
  Title must be a Conventional Commit — it becomes the squash commit on merge.
  e.g. feat(autopilot): add worktree pool for parallel delivery
-->

## What & why

<!-- One or two sentences: what this changes and the problem it solves. -->

Closes #<!-- issue number (required — forge is ticket-first) -->

## Acceptance criteria coverage

<!-- List each AC-ID from the issue and the test that proves it. -->

- [ ] AC1: <criterion> — covered by `<test file / name>`
- [ ] AC2: <criterion> — covered by `<test file / name>`

## Verification (be honest — "not verified" is a valid answer)

- [ ] `pnpm verify` passes locally
- [ ] What was verified: <!-- how you exercised the change end-to-end -->
- [ ] What was NOT verified / known gaps: <!-- state "none" only if true -->

## Checklist

- [ ] Linked to a tracking issue (`Closes #N`)
- [ ] Branch name follows `<type>/<issue>-<slug>`
- [ ] Commits follow Conventional Commits with an issue reference
- [ ] New/changed docs under `docs/` are added to the route index (`docs/README.md`); a new skill is mentioned in the handbook (docsync gate)
- [ ] No secrets, credentials, or personal data added
- [ ] I have read the [Contributing guide](../CONTRIBUTING.md) and agree to the [Code of Conduct](../CODE_OF_CONDUCT.md)
