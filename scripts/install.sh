#!/bin/bash
# Private Secretary one-liner installer for macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/noobsplzwin/private-secretary/dev/scripts/install.sh | bash
#
# What it does:
#   1. Ensures Node.js (>= 20) + Git (installs via Homebrew; installs Homebrew if missing)
#   2. Clones (or updates) the repo into ~/private-secretary
#   3. npm install
#   4. Installs the launchd agent (the 24/7 daemon; TickTick is the only surface)
#   5. Prints next steps (connect accounts — SETUP.md)
#
# Idempotent: safe to re-run — it updates the checkout and reloads the agents.
# macOS only for now (launchd); Linux support would swap step 4 for systemd.
#
# Environment overrides:
#   PRIVATE_SECRETARY_REPO   git URL to clone (default: the GitHub repo below —
#                            point at your fork/mirror if the origin moves)
#   PRIVATE_SECRETARY_REF    branch/tag to install (default: dev — the main
#                            branch is still the initial commit; flip the default
#                            to main once dev is merged)
#   PRIVATE_SECRETARY_HOME   install directory (default: ~/.private-secretary —
#                            hidden, so it never collides with a development
#                            checkout at ~/private-secretary or anywhere else)

set -euo pipefail

BOLD='\033[1m'
ACCENT='\033[38;2;37;99;235m'   # #2563EB — matches the cockpit primary
INFO='\033[38;2;100;116;139m'
SUCCESS='\033[38;2;5;150;105m'
WARN='\033[38;2;217;119;6m'
ERROR='\033[38;2;220;38;38m'
NC='\033[0m'

# ── Configuration — override via environment if the repo moves ────
# e.g. PRIVATE_SECRETARY_REPO=git@github.com:myfork/private-secretary.git bash install.sh
REPO_URL="${PRIVATE_SECRETARY_REPO:-https://github.com/noobsplzwin/private-secretary.git}"
# main is still the initial commit — everything real lives on dev for now.
REPO_REF="${PRIVATE_SECRETARY_REF:-dev}"
# Hidden dir by default (OpenClaw convention): a visible ~/private-secretary is
# almost always someone's DEVELOPMENT checkout — pulling/building/launchd-ing it
# would run whatever half-edited state it happens to be in. The installer owns
# this hidden copy; developers keep their own visible checkout elsewhere.
INSTALL_DIR="${PRIVATE_SECRETARY_HOME:-$HOME/.private-secretary}"
NODE_MIN_MAJOR=20

ui_info()    { echo -e "${INFO}·${NC} $*"; }
ui_success() { echo -e "${SUCCESS}✓${NC} $*"; }
ui_warn()    { echo -e "${WARN}!${NC} $*"; }
ui_error()   { echo -e "${ERROR}✗${NC} $*" >&2; }
ui_stage()   { echo ""; echo -e "${ACCENT}${BOLD}$*${NC}"; }

abort() { ui_error "$1"; shift; [ $# -gt 0 ] && echo "$*"; exit 1; }

# ── 0. macOS only ────────────────────────────────────────────────
if [[ "$OSTYPE" != "darwin"* ]]; then
    abort "This installer currently supports macOS only (launchd)." \
          "Linux/systemd support is not wired yet — install manually: $REPO_URL"
fi
ui_success "Detected: macOS"
ui_info "Repo: $REPO_URL (ref: $REPO_REF)"

# ── 1. Homebrew (only if we need it for git/node) ───────────────
install_homebrew() {
    if command -v brew &>/dev/null; then return 0; fi
    ui_info "Homebrew not found — installing it (you may be prompted for your password)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || abort "Homebrew install failed" "Install manually from https://brew.sh, then re-run."
    # Apple Silicon puts brew in /opt/homebrew/bin, Intel in /usr/local/bin —
    # neither is guaranteed on PATH in a curl|bash non-login shell.
    for p in /opt/homebrew/bin /usr/local/bin; do
        [[ -x "$p/brew" ]] && eval "$("$p/brew" shellenv)"
    done
    command -v brew &>/dev/null || abort "Homebrew installed but brew is still not on PATH"
    ui_success "Homebrew installed"
}

# ── 2. Git + Node ────────────────────────────────────────────────
# A non-login curl|bash shell may not have Homebrew's bin dirs on PATH even
# when brew/node are already installed — seed the usual suspects first.
for p in /opt/homebrew/bin /usr/local/bin; do
    [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
done

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

ui_stage "[1/5] Checking environment"

if ! command -v git &>/dev/null; then
    ui_info "Git not found"
    install_homebrew
    brew install git || abort "git install failed"
fi
ui_success "Git: $(git --version | awk '{print $3}')"

if command -v node &>/dev/null && [[ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]]; then
    ui_success "Node.js: $(node -v)"
else
    if command -v node &>/dev/null; then
        ui_info "Node.js $(node -v) is too old (need >= ${NODE_MIN_MAJOR}) — upgrading"
    else
        ui_info "Node.js not found — installing"
    fi
    install_homebrew
    brew install node || abort "Node.js install failed" "Or install from https://nodejs.org, then re-run."
    brew link node --overwrite --force 2>/dev/null || true
    hash -r
    [[ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]] \
        || abort "Node.js $(node -v 2>/dev/null || echo missing) still below v${NODE_MIN_MAJOR}" \
                 "Fix your PATH so the Homebrew node comes first, then re-run."
    ui_success "Node.js: $(node -v)"
fi

# ── 3. Clone / update + build ────────────────────────────────────
ui_stage "[2/5] Installing Private Secretary"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    ui_info "Existing checkout found at $INSTALL_DIR — updating"
    if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]]; then
        ui_warn "Local changes present — skipping git pull (keeping your checkout as-is)"
    else
        # Ensure we're on the right ref — a checkout cloned from the default
        # branch (main) may predate the installer knowing about REPO_REF.
        current_branch="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
        if [[ "$current_branch" != "$REPO_REF" ]]; then
            ui_info "Switching checkout from ${current_branch:-detached} to $REPO_REF"
            git -C "$INSTALL_DIR" fetch origin "$REPO_REF" || abort "git fetch failed for ref $REPO_REF"
            git -C "$INSTALL_DIR" checkout "$REPO_REF" || abort "git checkout $REPO_REF failed"
        fi
        git -C "$INSTALL_DIR" pull --ff-only || ui_warn "git pull failed — continuing with current checkout"
    fi
elif [[ -e "$INSTALL_DIR" ]]; then
    abort "$INSTALL_DIR exists but is not a git checkout" \
          "Move it aside, or set PRIVATE_SECRETARY_HOME to a different directory." \
          "Note: a development checkout at ~/private-secretary is NOT touched — the installer uses ~/.private-secretary."
else
    git clone --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR" || abort "git clone failed: $REPO_URL (ref: $REPO_REF)" \
        "Check network/GitHub access, or override: PRIVATE_SECRETARY_REPO=<url> PRIVATE_SECRETARY_REF=<branch> bash install.sh"
    ui_success "Cloned into $INSTALL_DIR ($REPO_REF)"
fi

cd "$INSTALL_DIR"
ui_info "Installing dependencies (this can take a minute)…"
npm install --no-fund --no-audit || abort "npm install failed"
ui_success "Dependencies installed"

# ── 4. launchd agent (24/7 daemon) ───────────────────────────────
ui_stage "[3/5] Starting the 24/7 daemon"
bash scripts/launchagent/install.sh || abort "launchd agent install failed"

# ── 5. Claude Code skills (/relay etc.) ──────────────────────────
# The runtime is a Claude Code skill — for a fresh user to get /relay, the
# repo's .claude/skills must be linked into their user-level ~/.claude/skills.
#
# ONLY the runtime skills below. .claude/skills also holds development skills
# (git-workflow, impeccable) that exist to build this product, not to run it —
# an end user has no business getting /git-workflow in their Claude Code from
# installing a secretary. Add a skill here only when the SECRETARY needs it.
RUNTIME_SKILLS=(relay owner-voice persona-bootstrap)

ui_stage "[4/5] Linking Claude Code skills (/relay, /persona-bootstrap…)"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$CLAUDE_SKILLS_DIR"
linked=0
for name in "${RUNTIME_SKILLS[@]}"; do
    skill_dir="$INSTALL_DIR/.claude/skills/$name"
    target="$CLAUDE_SKILLS_DIR/$name"
    if [[ ! -d "$skill_dir" ]]; then
        ui_warn "runtime skill '$name' missing from the checkout — skipping"
        continue
    fi
    if [[ -L "$target" && "$(readlink "$target")" == "$skill_dir" ]]; then
        continue  # already linked to this checkout
    fi
    if [[ -e "$target" && ! -L "$target" ]]; then
        ui_warn "~/.claude/skills/$name exists (not ours) — leaving it untouched"
        continue
    fi
    ln -sfn "$skill_dir" "$target"
    linked=$((linked + 1))
done

# Earlier installers linked EVERY skill dir, so existing users have dev skills
# (git-rebase, impeccable…) pointing into this checkout. Retract those. Only
# symlinks we own — resolving into $INSTALL_DIR — are touched; a user's own
# skill of the same name is a real dir or points elsewhere, and is left alone.
unlinked=0
for target in "$CLAUDE_SKILLS_DIR"/*; do
    [[ -L "$target" ]] || continue
    name="$(basename "$target")"
    [[ "$(readlink "$target")" == "$INSTALL_DIR/.claude/skills/"* ]] || continue
    for keep in "${RUNTIME_SKILLS[@]}"; do
        [[ "$name" == "$keep" ]] && continue 2
    done
    rm -f "$target"
    unlinked=$((unlinked + 1))
done

ui_success "Skills linked into ~/.claude/skills ($linked new)"
[[ $unlinked -gt 0 ]] && ui_info "Removed $unlinked non-runtime skill link(s) from an older install" || true
if ! command -v claude &>/dev/null; then
    ui_warn "Claude Code CLI not on PATH — /relay only runs inside Claude Code."
    echo "  Install it: https://claude.com/claude-code"
fi

# ── 6. Done ──────────────────────────────────────────────────────
ui_stage "[5/5] Verifying"
# The cockpit UI is retired (2026-08-14); the daemon is all there is to check.
if launchctl list 2>/dev/null | grep -q "tv.taiv.secretary"; then
    ui_success "Daemon loaded (tv.taiv.secretary)"
else
    ui_warn "Daemon not loaded — check: tail -F ~/Library/Logs/taiv-secretary/secretary.err.log"
fi

# printf, not a heredoc: heredocs do not interpret the \033 escapes in $SUCCESS/$BOLD.
printf '
%b%bPrivate Secretary installed.%b

  Daemon logs         : ~/Library/Logs/taiv-secretary/
  Checkout            : %s

Next: connect Slack / Gmail / TickTick — see SETUP.md.
Re-run this script any time to update to the latest version.

' "$SUCCESS" "$BOLD" "$NC" "$INSTALL_DIR"
