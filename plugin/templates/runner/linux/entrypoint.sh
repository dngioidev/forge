#!/usr/bin/env bash
# forge ephemeral Linux runner entrypoint (ADR-0005 decision 3).
#
# Consumes the one-hour JIT config the supervisor minted for THIS job and runs a
# single job (`--jitconfig` implies one-shot / ephemeral), then the container
# exits and `docker compose run --rm` tears it down. No `config.sh remove` is
# needed — a JIT runner auto-deregisters after its single job.
set -euo pipefail

# Run-time required-variable guard (#232). docker-compose.yml uses a build-safe
# default (`${ENCODED_JIT_CONFIG:-}`) so `build`/`config` parse without a JIT
# config; the hard "must be injected" guarantee lives HERE, at the one moment a
# job actually starts. Fail fast (do NOT echo the value) if it's empty.
if [[ -z "${ENCODED_JIT_CONFIG:-}" ]]; then
  echo "forge-runner: ENCODED_JIT_CONFIG is empty — the supervisor must mint a JIT config per job" >&2
  exit 1
fi

# The JIT config is a single-use, self-expiring credential (1h TTL, one job).
# Do not echo it. run.sh consumes it and removes the runner registration on exit.
exec ./run.sh --jitconfig "${ENCODED_JIT_CONFIG}"
