#!/bin/bash
# Install the Taiv Secretary LaunchAgents on macOS:
#   tv.taiv.secretary → the notification daemon (run-notify.ts)
#
# Substitutes @REPO_ROOT@ / @HOME@ / @NPX_PATH@ / @LOG_DIR@ in each template,
# writes to ~/Library/LaunchAgents, (re)loads it. Idempotent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${HOME}"
NPX_PATH="$(command -v npx)"
# Logs MUST live outside TCC-protected folders (~/Documents, ~/Desktop, ~/Downloads).
# launchd itself opens StandardOutPath/StandardErrorPath before exec'ing; when those
# paths sit under ~/Documents it is denied, the spawn fails with EX_CONFIG (78) and
# produces ZERO output, so KeepAlive retries forever (observed: 56,484 runs, daemon
# silently dead for 9 days). ~/Library/Logs is never TCC-gated.
LOG_DIR="${HOME}/Library/Logs/taiv-secretary"

if [[ -z "$NPX_PATH" ]]; then
    echo "❌ npx not found on PATH. Install Node.js / npm first." >&2
    exit 1
fi

mkdir -p "${HOME_DIR}/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

install_agent() {
    local label="$1"
    local src="${REPO_ROOT}/scripts/launchagent/${label}.plist.template"
    local dst="${HOME_DIR}/Library/LaunchAgents/${label}.plist"
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        echo "↻ booting out existing ${label}"
        launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
    fi
    sed \
        -e "s|@REPO_ROOT@|${REPO_ROOT}|g" \
        -e "s|@HOME@|${HOME_DIR}|g" \
        -e "s|@NPX_PATH@|${NPX_PATH}|g" \
        -e "s|@LOG_DIR@|${LOG_DIR}|g" \
        "$src" > "$dst"
    # enable first: a service left in the disabled state makes load/bootstrap
    # fail with an unexplained "Input/output error". The legacy `launchctl load`
    # also returns 0 on some failures — this script printed "✅ installed" while
    # nothing was running. Modern interface + verify, loudly.
    launchctl enable "gui/$(id -u)/${label}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$dst"
    if ! launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        echo "❌ ${label} did NOT load — check: launchctl print gui/$(id -u)/${label}" >&2
        exit 1
    fi
    echo "✅ installed & running: $dst"
}

install_agent "tv.taiv.secretary"

echo
echo "   daemon logs : ${LOG_DIR}/secretary.{out,err}.log   (heartbeat: notify-heartbeat.json)"
echo
echo "   tail -F ${LOG_DIR}/secretary.out.log"
echo "   launchctl unload ~/Library/LaunchAgents/tv.taiv.secretary.plist"
