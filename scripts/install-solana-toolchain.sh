#!/usr/bin/env bash
# Installs Solana CLI + Anchor (via AVM) from source inside the devcontainer.
#
# Why not in Dockerfile:
# - Only anchor-eng + qa-test-eng actually need these tools; spawning 5 other agents shouldn't wait 20 min.
# - Source builds on arm64-linux hit moving Rust-lint targets — easier to iterate interactively here.
# - Anza installer does not publish arm64-linux binaries as of v2.1.x.
#
# Run this ONCE when you start working with Anchor programs.
# Takes ~15–25 minutes (Rust compile of Solana + Anchor from source).

set -euo pipefail

AGAVE_VERSION="${AGAVE_VERSION:-v2.1.14}"

log() { printf "\033[1;34m[install-solana-toolchain]\033[0m %s\n" "$*"; }

# AGAVE_VERSION ships agave v2.1.x RUSTFLAGS workarounds for newer Rust toolchains.
# Bump the tag to a release with upstream fixes to drop these flags.
export RUSTFLAGS="-A dangerous_implicit_autorefs -A mismatched_lifetime_syntaxes"

install_agave_bin() {
  local bin="$1"
  if command -v "${bin}" >/dev/null 2>&1; then
    log "${bin} already installed: $(${bin} --version)"
    return
  fi
  log "Installing ${bin} from agave ${AGAVE_VERSION} (source build)…"
  cargo install \
    --git https://github.com/anza-xyz/agave \
    --tag "${AGAVE_VERSION}" \
    "${bin}" \
    --locked
}

# --- 1. Solana CLI + keygen (from agave source) ---
# Anza does not publish arm64-linux release binaries; cargo install each sub-crate one by one.
# solana-cli takes ~15 min (first build). solana-keygen is ~2 min (shares build cache).
install_agave_bin solana-cli
install_agave_bin solana-keygen

# --- 2. Anchor via AVM ---
# ANCHOR_VERSION pinned until end of MVP per M0 risk register — avoids IDL breakage from upgrades.
ANCHOR_VERSION="${ANCHOR_VERSION:-0.31.1}"

if command -v avm >/dev/null 2>&1; then
  log "avm already installed"
else
  log "Installing AVM (Anchor Version Manager)…"
  cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
fi

if ! avm list 2>/dev/null | grep -q "^${ANCHOR_VERSION} "; then
  log "Installing Anchor ${ANCHOR_VERSION} from source via AVM…"
  avm install "${ANCHOR_VERSION}" --from-source
fi
avm use "${ANCHOR_VERSION}"

# --- 3. solana-test-validator ---
# TODO: the cargo crate `solana-test-validator` is a library (no bin target). Install path
# still to be resolved — options: docker sidecar `solanalabs/solana` image, `surfpool`, or
# build from a different agave sub-crate. For now qa-test-eng can run test-validator via a
# detached container when needed.

# --- 4. Summary ---
log "Done."
echo
echo "solana: $(solana --version)"
echo "anchor: $(anchor --version)"
echo
echo "Reminder: solana-test-validator is NOT installed yet — see TODO in this script."
