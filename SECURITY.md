# Security Policy

forge is a Claude Code plugin that automates a development pipeline — it runs
scripts, hooks, and gates against a contributor's repository and GitHub board.
We take the security of that surface seriously and appreciate reports made
responsibly.

## Supported versions

forge is distributed through the Claude Code plugin marketplace and ships from
`main`. Security fixes are applied to the latest released version. Always run the
most recent release; older versions are not separately patched.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security
vulnerability.** Public disclosure before a fix is available puts every user at
risk.

Report privately through **GitHub's private vulnerability reporting**:

1. Go to the repository's **[Security tab](https://github.com/dngioidev/forge/security)**.
2. Click **"Report a vulnerability"** to open a private security advisory.
3. Describe the issue with the detail below.

This channel is private between you and the maintainer — it does not expose any
personal email address and keeps the report confidential until a fix ships.

If you cannot use GitHub's private reporting, contact the maintainer
**[@dngioidev](https://github.com/dngioidev)** through their GitHub profile to
arrange a private disclosure channel.

## What to include

A good report lets us reproduce and assess quickly:

- The affected component (a skill, gate, hook, board script, the graph MCP
  server, a workflow, …) and version/commit.
- A clear description of the vulnerability and its impact (e.g. command
  injection, secret exposure, privilege escalation, supply-chain risk).
- Step-by-step reproduction, including any configuration (`.claude/forge.json`)
  or environment needed.
- A proof of concept if you have one, and any suggested remediation.

## What to expect

- **Acknowledgement** within **3 business days** of your report.
- An initial **assessment and severity triage** within **7 business days**.
- Ongoing updates as we work a fix; we will coordinate a disclosure timeline
  with you and credit you in the advisory unless you prefer to remain anonymous.
- A published GitHub Security Advisory and release once the fix is available.

## Scope

In scope: the forge plugin code in this repository — skills, `plugin/scripts/**`
(gates, hooks, board automation, the graph server), CI workflows, and shipped
templates.

Out of scope: vulnerabilities in Claude Code itself, GitHub, Node.js, pnpm, or
third-party dependencies (report those upstream — though we welcome a heads-up if
a dependency advisory affects forge). Findings that require an already-privileged
local attacker or social engineering of the maintainer are generally out of
scope.

Thank you for helping keep forge and its users safe.
