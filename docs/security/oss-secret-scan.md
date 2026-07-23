# OSS gate — full-history secret & credential scan (issue #210)

**Epic:** #209 (open-source the repository) · **Gate:** hard, pre-publish (irreversible once public)
**Date:** 2026-07-23 · **Scope:** every commit on every ref that becomes public at flip
(49 branches + 91 PR refs + 17 tags → 204 unique content-bearing commits, ~1.5 MB)

Once the repo is public, **all history is public** — not just the current tree. This scan
covers the complete published history via a `--mirror` clone of `origin` (mirror = exactly
the refs that become public), not just the working tree.

---

## AC1 — scans run (both tools, full history, all refs)

Reproduce from a mirror clone (guarantees all branches, tags, and PR refs):

```sh
# 1. Mirror all published refs (branches + tags + refs/pull/*)
git clone --mirror https://github.com/dngioidev/forge.git mirror.git

# 2. gitleaks v8.30.1 — full history, all refs, redacted output
docker run --rm -v "$PWD/mirror.git:/repo" \
  ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  detect --source=/repo --no-git=false --redact \
  --log-opts="--all --glob=refs/pull/*"

# 3. trufflehog v3.95.9 — full history, verified + unknown detectors
#    (trufflehog wants a working .git, so scan a non-bare clone that has every
#     ref materialised as a local branch)
docker run --rm -v "$PWD/work:/repo" \
  trufflesecurity/trufflehog@sha256:59b244249d1a1aef4baa24fe73d3c931616264482580d806d77f6c74d26b3e42 \
  git file:///repo --results=verified,unknown --json
```

**Raw results (2026-07-23):**

| Tool | Version | Commits/chunks scanned | Findings |
| --- | --- | --- | --- |
| gitleaks | v8.30.1 | 204 commits (all refs) | 5 (all false positives — see AC2) |
| trufflehog | v3.95.9 | 1368 chunks, all 265 reachable commits | **0 verified, 0 unverified** |

trufflehog's format/checksum-aware detectors did not match any of the 5 strings
gitleaks flagged — corroborating that they are not real credentials.

Digest provenance: the pinned gitleaks digest was obtained by pulling
`ghcr.io/gitleaks/gitleaks:latest`, which self-reported `version v8.30.1`; its
`RepoDigests` entry is the `sha256:c00b6bd0…` used in `secret-scan.yml`. Pinning
by digest is deliberate so CI runs that exact image indefinitely even as
`:latest` moves.

---

## AC2 — triage (every finding)

All 5 gitleaks hits are **false positives**: strings deliberately shaped like
secrets so the repo's own tests can prove the pre-send scanner and the journal
redactor catch them. Values redacted here per the ticket's no-plaintext rule.

| # | Rule | File : line | Verdict | Reason |
| --- | --- | --- | --- | --- |
| 1 | `generic-api-key` | `tests/backends/presend.test.mjs:20` | False positive | Fixture in a test that asserts `scanPrompt` **refuses** secret-shaped input. File is history-only (presend backend was later removed). |
| 2 | `jwt` | `tests/backends/presend.test.mjs:11` | False positive | Fabricated JWT in the same "refuses known secret patterns" fixture list. |
| 3 | `aws-access-token` | `tests/lib/journal.test.mjs:47` | False positive | `AKIAABCDEFGHIJKLMNOP` — a fabricated AWS-shaped key inside a `redact({ nested: { list: [...] } })` test asserting nested values are scrubbed. |
| 4 | `generic-api-key` | `tests/lib/journal.test.mjs:35` | False positive | Fake `GH_TOKEN=ghp_…` in a test asserting the journal redacts it to `[redacted]`. |
| 5 | `generic-api-key` | `tests/lib/journal.test.mjs:36` | False positive | Fake `token:` value in the same redaction test. |

**No true positives. No rotation and no history rewrite are required.**

Note: the deleted `presend.test.mjs` also contained `AKIAIOSFODNN7EXAMPLE` (AWS's
own documented example key) at its line 8, but it is **not** among the 5 findings
— gitleaks' default ruleset already allowlists that well-known literal.

These fixtures are excluded going forward by `.gitleaks.toml` — path-scoped to the
two exact fixture files (present + historical, anchored `^…$`), plus a redundant
explicit regex for the AWS example literal as defense-in-depth. A real credential
added **anywhere else** is still caught. Re-scanning the full history **with** that
config returns `no leaks found` (0).

---

## AC3 — enable GitHub secret scanning + push protection (run AT FLIP time)

These require the repo to be public (or GHAS); free for public repos. Not enabled
by this ticket — run when #209 flips visibility:

1. Flip the repo to **Public** (owner action, tracked by epic #209).
2. **Settings → Code security and analysis:**
   - **Secret scanning** → **Enable**.
   - **Push protection** → **Enable** (blocks new commits that introduce detected secrets).
3. CLI equivalent (needs `admin:repo` scope):
   ```sh
   gh api -X PATCH repos/dngioidev/forge \
     -f security_and_analysis[secret_scanning][status]=enabled \
     -f security_and_analysis[secret_scanning_push_protection][status]=enabled
   ```
4. Verify: `forge:doctor` reports secret scanning + push protection on; and
   **Settings → Code security** shows both enabled with the alerts tab reachable.
5. The `secret-scan` workflow (this PR) then runs free on every push/PR as the
   ongoing regression gate, complementing GitHub's native scanning.

---

## AC4 — sign-off (OWNER action — hard gate for the public flip)

Based on the two independent full-history scans above (gitleaks: 5 findings, all
triaged as fake test fixtures; trufflehog: 0), the delivery agent's finding is:

> No live secrets were found in the tree or in the full git history.

The **attestation itself is the owner's to give**. Owner: confirm the triage
above and record, on issue #210:

> ✅ Signed off: **no live secrets remain in tree or history.** — @<owner>, 2026-07-__

Until that line exists, the epic #209 public flip stays blocked.
