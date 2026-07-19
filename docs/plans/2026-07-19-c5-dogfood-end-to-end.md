# C5 — dogfood one real ticket end-to-end through the control queue

**Ticket:** #70 (board #12) · **Payload:** #71 · **Epic:** #56 · **Spec:** forge-control §2.

Prove C1–C4 work together as a live control plane: **enqueue → headless `claude -p` session (write+push enabled) → PR → owner merge**. Owner authorized a **full autonomous run**. The control plane never merges — the session opens the PR, the owner merges it.

Unlike C1–C4 this epic produces little code of its own; its artifact is the **payload PR** (#71, `control/README.md`) the autonomous session generates, plus the captured evidence. The plan doc is committed to main; the run is executed and evidenced, not branched.

## Tasks

- [ ] T1 — **Spike the write-permission spawn** (the piece the C2 §12 spike left unverified): in a throwaway sandbox git repo, run a headless session with writes enabled (`--permission-mode bypassPermissions`) and confirm it edits a file + runs git without prompts, exit 0. **Files:** (sandbox only — not committed)
- [ ] T2 — **Enqueue the payload** (#71 brief) into a real control base and drive `runOnce`/`work` with write+push perms + a supervised timeout, on the real forge repo. The session creates `control/README.md`, commits on a branch, pushes, and opens a PR — no merge. **Files:** (produces the payload branch/PR; runner code already shipped in C2)
- [ ] T3 — **Supervise + capture**: runner journal (session-start/end, outcome, cost), the pushed branch + PR link, the trail line the runner posts on #71, and the acked queue entry. **Files:** (evidence only)
- [ ] T4 — **Verify the payload PR** independently (full suite + the 4 gates green on it) and post evidence to #70 with an honest note on anything the autonomous session got wrong or needed correcting. Owner merges #71. **Files:** (evidence only)

## Acceptance criteria

- AC-C5.1 — the permission-bypass spawn is verified in a sandbox before any real-repo run (headless session writes a file + commits without prompting).
- AC-C5.2 — the payload ticket is enqueued and driven through the runner; the session opens a real PR (branch pushed, `gh pr create`) and does NOT merge.
- AC-C5.3 — the run is supervised: journal records session-start/end with outcome + cost; #71 gets a trail line; the queue entry is acked.
- AC-C5.4 — evidence (PR link, journal excerpt, cost) is posted to #70 with an honest note on autonomous-session quality.

## Out of scope

Trace/conformance (C6), alerts (C7), quota (C8). The `--loop` continuous daemon isn't required — a single supervised drain proves the path.
