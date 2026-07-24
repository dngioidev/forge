#!/usr/bin/env bash
# forge local runner service installer (Linux, systemd --user) - #253 AC1-AC3, #260.
#
# Turns the foreground JIT supervisor (runner/linux/supervisor.mjs) into a durable
# systemd --user service, so the Linux CI leg survives logout/reboot instead of
# dying with a WSL terminal. Foreground `node supervisor.mjs` is now the quick-test
# path; this is the durable default.
#
# MULTI-REPO (#260): the unit name is REPO-DERIVED (forge-runner-<owner>-<repo>) so a
# second repo installs a DISTINCT service instead of clobbering the first. The install
# target (owner/repo) is threaded into the unit's Environment= (not inferred from the
# checkout), and the installer REFUSES to overwrite a same-named unit that targets a
# DIFFERENT owner/repo unless --force is passed. Override the name with --name.
#
# SECRET MODEL (ADR-0005): the PAT is NEVER written here. The generated unit loads
# it from the gitignored, chmod-600 ~/.forge/runner.env via systemd EnvironmentFile.
# This script only writes a unit that REFERENCES that store; it never reads, echoes,
# copies, or hardcodes the token.
#
# Usage:
#   ./install-service.sh                       install + enable --now + attempt linger
#   ./install-service.sh --name forge-runner-x install under an explicit unit name
#   ./install-service.sh --owner o --repo r    install for an explicit target owner/repo
#   ./install-service.sh --force               overwrite a same-named unit for a different target
#   ./install-service.sh --uninstall           stop + disable --now + remove the unit
set -euo pipefail

log() { printf '[forge-runner-install] %s\n' "$1"; }

# Sanitize an owner/repo token into a valid systemd unit-name fragment: lowercase,
# every run of non-alphanumerics collapsed to a single '-', trimmed of edge dashes.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# Repo-derived unit name: forge-runner-<owner>-<repo> (#260). Falls back to a bare
# forge-runner when neither resolves, so a never-substituted copy still installs.
derive_service_name() {
  local o r name
  o="$(slugify "$1")"
  r="$(slugify "$2")"
  name="forge-runner"
  [ -n "$o" ] && name="$name-$o"
  [ -n "$r" ] && name="$name-$r"
  printf '%s' "$name"
}

# Best-effort: read an existing unit's resolved target (owner/repo) from its
# Environment= line. Prints owner/repo or nothing. Never reads the PAT.
existing_unit_target() {
  local unit="$1" o r
  [ -f "$unit" ] || return 0
  o="$(sed -n 's/.*FORGE_RUNNER_OWNER=\([^[:space:]"]*\).*/\1/p' "$unit" | head -n1)"
  r="$(sed -n 's/.*FORGE_RUNNER_REPO=\([^[:space:]"]*\).*/\1/p' "$unit" | head -n1)"
  if [ -n "$o" ] && [ -n "$r" ]; then printf '%s/%s' "$o" "$r"; fi
}

# Install target resolution (#260): explicit --owner/--repo win, then the service
# environment, then the scaffold-time substituted defaults. Never inferred from the
# checkout dir alone - the resolved pair is written into the unit's Environment=.
OWNER_DEFAULT="{{OWNER}}"
REPO_DEFAULT="{{REPO}}"
OWNER="${FORGE_RUNNER_OWNER:-$OWNER_DEFAULT}"
REPO="${FORGE_RUNNER_REPO:-$REPO_DEFAULT}"
NAME_OVERRIDE=""
FORCE=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|-u) UNINSTALL=1 ;;
    --force|-f) FORCE=1 ;;
    --name) shift; NAME_OVERRIDE="${1:-}" ;;
    --name=*) NAME_OVERRIDE="${1#*=}" ;;
    --owner) shift; OWNER="${1:-}" ;;
    --owner=*) OWNER="${1#*=}" ;;
    --repo) shift; REPO="${1:-}" ;;
    --repo=*) REPO="${1#*=}" ;;
    *) log "unknown argument: $1 (install | --name <n> | --owner <o> --repo <r> | --force | --uninstall)"; exit 2 ;;
  esac
  shift
done

if [ -n "$NAME_OVERRIDE" ]; then
  SERVICE="$NAME_OVERRIDE"
else
  SERVICE="$(derive_service_name "$OWNER" "$REPO")"
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/${SERVICE}.service"
ENV_FILE="$HOME/.forge/runner.env"

uninstall() {
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  log "removed $SERVICE (unit deleted, service disabled)."
  log "the PAT store $ENV_FILE was left untouched - delete it yourself if retiring the runner."
  exit 0
}

if [ "$UNINSTALL" = "1" ]; then uninstall; fi

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

# AC3 (#260): warn (never block) when the install target differs from the current
# directory's repo, so a wrong-checkout install is visible. Best-effort; gh absent
# or a non-repo dir simply skips the check.
if command -v gh >/dev/null 2>&1; then
  CURRENT_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
  if [ -n "$CURRENT_REPO" ] && [ "$CURRENT_REPO" != "$OWNER/$REPO" ]; then
    log "WARNING: install target '$OWNER/$REPO' differs from this directory's repo '$CURRENT_REPO' (gh repo view)."
    log "  Installing for '$OWNER/$REPO' anyway; pass --owner/--repo to change the target."
  fi
fi

# AC4 (#260): refuse to clobber a same-named unit that targets a DIFFERENT owner/repo
# unless --force. A same-target unit is just an idempotent reinstall.
if [ -f "$UNIT" ]; then
  EXISTING_TARGET="$(existing_unit_target "$UNIT")"
  if [ -n "$EXISTING_TARGET" ] && [ "$EXISTING_TARGET" != "$OWNER/$REPO" ]; then
    if [ "$FORCE" != "1" ]; then
      log "ERROR: unit $UNIT already exists and targets '$EXISTING_TARGET', but this install targets '$OWNER/$REPO'."
      log "  Refusing to clobber a different repo's runner. Re-run with --force to override, or pass --name to install a distinct service."
      exit 1
    fi
    log "WARNING: --force overriding existing $SERVICE (was '$EXISTING_TARGET', now '$OWNER/$REPO')."
  fi
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
Description=forge local self-hosted runner supervisor ($OWNER/$REPO, JIT + ephemeral)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# The one secret: loaded from the gitignored, chmod-600 store - NEVER committed,
# never on argv, never inline in this unit (ADR-0005). The supervisor reads
# FORGE_RUNNER_PAT from this service environment only.
EnvironmentFile=%h/.forge/runner.env
# Explicit target (#260): the supervisor serves THIS owner/repo from the unit env,
# not whatever the checkout happens to be.
Environment=FORGE_RUNNER_OWNER=$OWNER FORGE_RUNNER_REPO=$REPO
Environment=FORGE_RUNNER_CONCURRENCY=1
ExecStart=/usr/bin/env node $SUPERVISOR
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
log "wrote $UNIT (target $OWNER/$REPO)"

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
