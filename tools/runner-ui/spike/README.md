# tools/runner-ui/spike -- THROWAWAY spike code (#263)

This directory is disposable proof-of-concept code for the ADR-0006 spike
(ticket #263, AC2). It is NOT the runner-ui product and MUST NOT be built on.

- `probe.py` -- proves the recommended stack (Python + shell-out) can list at
  least one REAL forge-runner service's state cross-platform (Windows `sc.exe`,
  Linux `systemctl --user`, `docker ps`), without reimplementing any service
  manager and without ever reading `~/.forge/runner.env` or printing the PAT.

When ADR-0006 is approved, the real tool is built fresh under `tools/runner-ui/`
via the normal plan/execute flow; delete this `spike/` directory then.
