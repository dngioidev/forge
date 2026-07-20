# Plan — batch close for board/close.mjs (#123)

**Kind:** feature · **Ticket:** #123 · Authored by the `planner` subagent (forge:deliver shakedown).

Goal: `board/close.mjs` accepts a comma-separated `--issue` list and closes each with the shared `--reason`/`--note`, returning a per-issue summary — while a single `--issue` stays byte-for-byte back-compatible.

## T1 — parse a list + `runCloseBatch` (kind: code)

**Files:** plugin/scripts/board/close.mjs

- `parseArgs`: parse `--issue` into a list (`a.issues`), splitting on `,` and trimming; `Number('12,13')` is `NaN` today, so this must change. Keep a single lone number working.
- Add `export async function runCloseBatch(ctx, args, log)` that validates `args.reason` against `REASONS` **once, before any GitHub call** (fail-fast), then reuses the existing single-issue `runClose` per issue. `runClose` is unchanged and already idempotent.
- Return `{ ok, closed, failed, results }` (the `runCreateBatch` precedent). `ok` only when every issue closed; continue past a per-issue failure.
- **Back-compat:** a length-1 list routes to `runClose` directly so a lone `--issue 12` returns the unchanged single shape `{ ok, issue, reason, status }`, not a batch summary.
- `isMain`: dispatch single vs batch, print the summary, nonzero exit on any failure.

**AC-IDs:** AC-123.1, AC-123.2, AC-123.3

**Test plan (write first):** AC-123.3 — `--issue 12,13 --reason bogus` → `ok:false`, `/--reason must be one of/`, and no `issue view`/`issue close`/`item-edit` call (assert via `ctxWith` `calls`). AC-123.2 — a lone `--issue 12` through the new entry returns the single-issue shape, not a `results` array.

## T2 — batch happy-path + partial-failure tests (kind: test)

**Files:** tests/board.test.mjs

- Add `runCloseBatch` to the `close.mjs` import (board.test.mjs:11).
- **AC-123.1** happy path: `--issue 12,13 --reason not-planned --note "…"` → `{ ok:true, closed:2, failed:0 }`, one `results` entry per issue, `issue close … not planned` for both, the `--note` reaches each trail body, idempotent on re-run.
- **AC-123.1** partial failure: one issue's `issue view` fails → `{ ok:false, closed:1, failed:1 }`, `results` names which failed vs closed (continue-past-failure, per `runCreateBatch`).

**AC-IDs:** AC-123.1

## AC coverage
- AC-123.1 → T1 (batch orchestration) + T2 (tests)
- AC-123.2 → T1 (single-issue dispatch) + named test
- AC-123.3 → T1 (validate reason before any gh call) + named test
