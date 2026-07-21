---
name: investigate
description: Unknown-cause bug → root cause + fix proposal on the ticket. Use when a bug can't be fixed directly because nobody knows why it happens yet (reproduce → bisect → narrow → propose).
---

# forge:investigate

Debugging as a discipline, separate from building (spec §4 item 13). The deliverable is a **root cause + fix proposal on the ticket** — not a fix. The fix goes through execute (planned) or hotfix (urgent).

**Optional Gemini offload (opt-in):** when `features.agy` is on, read-only "where does X happen / what calls Y" lookups can be offloaded to Gemini to save Claude quota — `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy/ask.mjs" --question "…"`. Advisory + read-only; verify anything it claims against the code before acting.

## Steps

1. **Ticket check**: the bug must have a ticket (triage first). Trail: `comment.mjs --phase started --body "investigating: <hypothesis>"`.
2. **Reproduce**: build the smallest reliable repro; record exact steps/inputs in a ticket comment. Can't reproduce → document what was tried, mark "needs repro info," stop — no speculative fixes, ever.
3. **Bisect when regression-shaped**: `git bisect` between last-known-good and first-known-bad; the culprit commit + its ticket usually explain intent.
4. **Narrow**: trace from the repro inward — grep the error, read the failing path, instrument locally if needed. (Graph tools `who_uses`/`blast_radius` take over at SP8; until then grep + imports.)
5. **Root cause statement**: one paragraph — what breaks, why, since when, blast radius (what else the same flaw touches). Post on the ticket.
6. **Fix proposal**: files to change, approach, the regression test that must exist *before* the fix (spec §13 law), risk notes. Post on the ticket; re-size/re-prioritize via `move.mjs`/field edit if the severity changed.
7. **No failing-test-first here** — you can't test what you can't reproduce; the regression test lands with the fix in execute/hotfix.

Escalate (spec §7) when: the root cause implies a security issue (→ maybe `forge:respond`), the blast radius exceeds the ticket, or two full narrowing passes produced nothing.
