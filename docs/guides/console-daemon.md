# Console daemon — run it, what it sends, what comes back

The daemon (spec §11) is one process per machine, **outbound-only**: it snapshots every registered repo's pipeline state, publishes metadata to a transport, and resolves escalation decisions from replies. SP9a ships the transport-abstracted core; Firebase and the device app are the follow-up owner step.

## Quick start (file transport — live today)

```
node console/daemon.mjs register     # creates ~/.forge/daemon.json, adds this repo
node console/daemon.mjs once         # one cycle: collect → publish → inbox
node console/daemon.mjs watch        # the same, every intervalSec
node console/daemon.mjs status       # last-publish age per repo
```

Machine config `~/.forge/daemon.json`:

```jsonc
{
  "machineId": "<hostname>-<4hex>",       // stable; register never regenerates it
  "repos": ["C:/mywp/forge"],             // register appends the cwd it runs in
  "transport": { "kind": "file", "dir": "~/.forge/console" },
  "intervalSec": 60
}
```

## File transport layout

```
<dir>/<machineId>/telemetry.jsonl        append-only snapshots (one per repo per cycle)
<dir>/<machineId>/escalations.jsonl      pending decisions, idempotent per id
<dir>/<machineId>/decisions/<id>.json    INBOX — drop {"id": "...", "answer": "...", "by": "..."}
<dir>/<machineId>/decisions/<id>.json.done   consumed marker
```

Dropping a reply file resolves the matching `.forge/decisions/<id>.json` in whichever repo owns it — the exact shape `escalate.mjs --check` produces, so the halted pipeline resumes identically either way. The resolution is journaled (`escalation-resolved`, `via: console`).

## What leaves the machine (guardrail, not convention)

Telemetry is **allowlist-sanitized** (`console/lib/sanitize.mjs`): repo name, situation, branch/ticket refs, ledger counts, decision ids/reasons/option labels with ages, journal tail as `{ts, kind, ticket, gate, rule}`. Strings are capped. Code, diffs, and prompts have no field in the schema — they cannot pass, and a doc that fails the schema is refused rather than trimmed-and-sent.

## When Firebase arrives (owner step)

Provision a Firebase project (Auth + Firestore + FCM, free tier), then switch `transport` to `{"kind": "firestore", "projectId": "...", "authToken": "<minted from a service-account key>"}`. The adapter (`console/transports/firestore.mjs`) mirrors the file layout as documents under `machines/<machineId>/…`; it is structurally tested, not yet run against a live project. Token minting from a service-account key + FCM push + the device app land with the graduated `forge-console` repo (SP9b).
