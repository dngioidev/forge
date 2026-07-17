---
name: respond
description: Security incident response — containment before code. Use on suspected credential leak, injected code, malicious dependency, or any security breach signal.
---

# forge:respond

The law (spec §4 item 18): **containment before code.** Respond contains and hands off — it never ships the fix itself.

## 1. Contain (before anything else)

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/care/incident.mjs" respond-open --reason "<signal>"` — the situation flips to 🔒 security-response, which **mechanically**: freezes ship/release for every branch, disables CLI backends (`runRole` falls back to Claude — no repo content reaches third-party models during a suspected leak), and leaves only respond + investigate runnable (situation gate).
2. **Rotate/revoke** every credential the breach could have touched — tokens, deploy keys, service accounts. Rotation is containment; investigation waits.
3. Deploys are frozen by the gate; if something is mid-deploy, let it finish or roll back — never push new code during containment.

## 2. Forensics

- The journal is evidence: `escalation`/`blocked-edit`/`backend-fallback` events, and **backend-call prompt hashes** show what left the machine and when.
- `git log` + the graph's ticket edges scope what a compromised credential could reach.
- **Scrub-and-rotate over history rewrites** (spec §4): a leaked secret is dead the moment it's rotated; rewriting published history is denylisted and destroys the evidence trail.

## 3. Disclose & hand off

- Users affected ⇒ a disclosure note is part of containment, not an afterthought.
- The vulnerability fix ships via **forge:hotfix** *after* containment — respond opens that ticket and hands off; the hotfix runs under incident rules.

## 4. Close

Postmortem filed (mandatory), then `incident.mjs respond-close --postmortem "#<n>"` — the situation clears and normal work resumes. `respond-close` refuses without the postmortem ref.
