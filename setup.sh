#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# Local setup — run this after cloning the repo
#
# Usage:
#   git clone https://github.com/mellofordev/harness && cd harness
#   ./setup.sh
# ─────────────────────────────────────────────────────────────────

G='\033[0;32m'; C='\033[0;36m'; Y='\033[0;33m'; B='\033[1m'; D='\033[0m'

printf "\n${B}⬡ Harness CLI — Local Setup${D}\n\n"

# check bun
if ! command -v bun &>/dev/null; then
  printf "${Y}▲${D} Bun not found — installing...\n"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

printf "${C}▸${D} Bun v$(bun --version)\n"

# install deps
printf "${C}▸${D} Installing dependencies...\n"
bun install

# link globally
printf "${C}▸${D} Linking 'harness' command...\n"
bun link

printf "\n${G}${B}✓ Done!${D} You can now run ${C}harness${D} from anywhere.\n\n"
printf "  Try:\n"
printf "    ${C}harness --help${D}\n"
printf "    ${C}harness init${D}\n"
printf "    ${C}harness demo${D}\n\n"
