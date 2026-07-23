#!/usr/bin/env bash
# forge local runner service installer (Linux, systemd --user) - #253 AC1-AC3.
#
# Turns the foreground JIT supervisor (runner/linux/supervisor.mjs) into a durable
# systemd --user service, so the Linux CI leg survives logout/reboot instead of
# dying with a WSL terminal. Foreground `node supervisor.mjs` is now the quick-test
# path; this is the durable default.
#
# SECRET MODEL (ADR-0005): the PAT is NEVER written here. The generated unit loads
# it from the gitignored, chmod-600 ~/.forge/runner.env via systemd EnvironmentFile.
# This script only writes a unit that REFERENCES that store; it never reads, echoes,
# copies, or hardcodes the token.
#
# Usage:
#   ./install-service.sh              install + enable --now + attempt linger
#   ./install-service.sh --uninstall  stop + disable --now + remove the unit
set -euo pipefail

SERVICE=forge-runner
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/${SERVICE}.service"
ENV_FILE="$HOME/.forge/runner.env"

log() { printf '[forge-runner-install] %s\n' "$1"; }

uninstall() {
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  log "removed $SERVICE (unit deleted, service disabled)."
  log "the PAT store $ENV_FILE was left untouched - delete it yourself if retiring the runner."
  exit 0
}

case "${1:-}" in
  --uninstall|-u) uninstall ;;
  '') ;; # install path
  *) log "unknown argument: $1 (pass nothing to install, or --uninstall to remove)"; exit 2 ;;
esac

# Resolve the absolute path to supervisor.mjs relative to THIS script's location
# (runner/linux/), so the unit's ExecStart is host-independent.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
SUPERVISOR="$SCRIPT_DIR/supervisor.mjs"

if [ ! -f "$SUPERVISOR" ]; then
  log "supervisor not found at $SUPERVISOR - run this from the repo's runner/linux/ scaffold."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  log "node not found on PATH - install Node >= 22.13 before enabling the service."
  exit 1
fi

# The service will fail to start without the PAT store. Warn clearly (never write it).
if [ ! -f "$ENV_FILE" ]; then
  log "WARNING: $ENV_FILE is missing. The service loads FORGE_RUNNER_PAT from it via"
  log "  systemd EnvironmentFile= and will FAIL to start until you create it:"
  log "    mkdir -p ~/.forge && chmod 700 ~/.forge"
  log "    printf 'FORGE_RUNNER_PAT=<token>\\n' > ~/.forge/runner.env && chmod 600 ~/.forge/runner.env"
  log "  Create it, then re-run this installer (or: systemctl --user start $SERVICE)."
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=forge local self-hosted runner supervisor (JIT + ephemeral)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# The one secret: loaded from the gitignored, chmod-600 store - NEVER committed,
# never on argv, never inline in this unit (ADR-0005). The supervisor reads
# FORGE_RUNNER_PAT from this service environment only.
EnvironmentFile=%h/.forge/runner.env
Environment=FORGE_RUNNER_CONCURRENCY=1
ExecStart=/usr/bin/env node $SUPERVISOR
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
log "wrote $UNIT"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
log "enabled + started $SERVICE"

# Boot/logout persistence: linger keeps --user services running while you are not
# logged in. It may need privileges (polkit/sudo) - degrade gracefully with a note
# rather than hard-failing an otherwise-successful install.
if loginctl enable-linger "$USER" >/dev/null 2>&1; then
  log "linger enabled for $USER - the service survives logout/reboot."
else
  log "NOTE: could not enable linger automatically (it usually needs privileges)."
  log "  For boot/logout persistence, run once:  sudo loginctl enable-linger $USER"
fi

log "check status:  systemctl --user status $SERVICE"
log "follow logs:   journalctl --user -u $SERVICE -f"
