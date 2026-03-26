#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# Harness CLI installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mellofordev/harness/main/install.sh | bash
#
# What it does:
#   1. Checks for (or installs) Bun
#   2. Clones the repo into ~/.harness-cli
#   3. Installs dependencies
#   4. Compiles a standalone binary
#   5. Drops it into /usr/local/bin (or ~/.local/bin)
#
# To uninstall:
#   harness-uninstall   (installed alongside harness)
# ─────────────────────────────────────────────────────────────────

REPO="https://github.com/mellofordev/harness.git"
INSTALL_DIR="$HOME/.harness-cli"
VERSION="main"

# colors
R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; C='\033[0;36m'; B='\033[1m'; D='\033[0m'

info()  { printf "${C}▸${D} %s\n" "$*"; }
ok()    { printf "${G}✓${D} %s\n" "$*"; }
warn()  { printf "${Y}▲${D} %s\n" "$*"; }
fail()  { printf "${R}✖ %s${D}\n" "$*" >&2; exit 1; }

# ─── Banner ─────────────────────────────────────────────────────

printf "\n${B}⬡ Harness CLI Installer${D}\n"
printf "  Multi-agent AI orchestrator\n\n"

# ─── Detect OS & arch ───────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="macos" ;;
  *)       fail "Unsupported OS: $OS. Harness supports macOS and Linux." ;;
esac

info "Platform: $PLATFORM ($ARCH)"

# ─── Determine install target directory ─────────────────────────

BIN_DIR=""

if [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
elif [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
else
  mkdir -p "$HOME/.local/bin"
  BIN_DIR="$HOME/.local/bin"
fi

info "Binary will be installed to: $BIN_DIR"

# ─── Check / install Bun ────────────────────────────────────────

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
  ok "Bun found: v$BUN_VERSION"
else
  info "Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash

  # Source bun into current shell
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command -v bun &>/dev/null; then
    fail "Bun installation failed. Install manually: https://bun.sh"
  fi
  ok "Bun installed: v$(bun --version)"
fi

# ─── Clone or update the repo ───────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin "$VERSION" 2>/dev/null || {
    warn "Could not pull updates — using existing code"
  }
else
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning harness-cli..."
  git clone --depth 1 --branch "$VERSION" "$REPO" "$INSTALL_DIR" 2>/dev/null || \
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
ok "Source ready at $INSTALL_DIR"

APP_VERSION="$(bun -e "console.log(require('./package.json').version)" 2>/dev/null || echo "$VERSION")"
info "Installing Harness CLI version: $APP_VERSION"

# ─── Install dependencies ───────────────────────────────────────

info "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Dependencies installed"

# ─── Compile standalone binary ──────────────────────────────────

info "Compiling binary..."
bun build src/cli.ts --compile --outfile "$INSTALL_DIR/dist/harness"

if [ ! -f "$INSTALL_DIR/dist/harness" ]; then
  fail "Compilation failed — dist/harness not found"
fi

ok "Binary compiled"

# ─── Install to bin dir ─────────────────────────────────────────

cp "$INSTALL_DIR/dist/harness" "$BIN_DIR/harness"
chmod +x "$BIN_DIR/harness"
ok "Installed harness to $BIN_DIR/harness"

# ─── Create uninstall script ────────────────────────────────────

cat > "$BIN_DIR/harness-uninstall" << 'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail
printf "Uninstalling harness-cli...\n"
rm -rf "$HOME/.harness-cli"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
rm -f "$SELF_DIR/harness"
rm -f "$SELF_DIR/harness-uninstall"
printf "✓ Harness CLI uninstalled.\n"
UNINSTALL
chmod +x "$BIN_DIR/harness-uninstall"

# ─── Verify PATH ────────────────────────────────────────────────

if ! echo "$PATH" | tr ':' '\n' | grep -q "^${BIN_DIR}$"; then
  warn "$BIN_DIR is not in your PATH"
  printf "\n  Add this to your shell config (~/.bashrc, ~/.zshrc, etc.):\n"
  printf "    ${C}export PATH=\"$BIN_DIR:\$PATH\"${D}\n\n"
fi

# ─── Done ────────────────────────────────────────────────────────

printf "\n${G}${B}✓ Harness CLI installed successfully!${D}\n\n"
printf "  Get started:\n"
printf "    ${C}harness version${D}\n"
printf "    ${C}harness --help${D}\n"
printf "    ${C}harness init${D}\n"
printf "    ${C}harness demo${D}\n\n"
printf "  To uninstall:\n"
printf "    ${C}harness-uninstall${D}\n\n"
