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

# --- 1. Solana CLI (from agave source) ---
if command -v solana >/dev/null 2>&1; then
  log "solana already installed: $(solana --version)"
else
  log "Installing Solana CLI from agave ${AGAVE_VERSION} (this takes ~15 min)…"
  # RUSTFLAGS: agave v2.1.14 code predates the `dangerous_implicit_autorefs` lint that's
  # deny-by-default in newer Rust; also silence the lifetime-syntax warning that newer
  # toolchains promote. Bump AGAVE_VERSION to a release with upstream fixes to drop these.
  RUSTFLAGS="-A dangerous_implicit_autorefs -A mismatched_lifetime_syntaxes" \
    cargo install \
      --git https://github.com/anza-xyz/agave \
      --tag "${AGAVE_VERSION}" \
      solana-cli \
      --locked
fi

# --- 2. Anchor via AVM ---
if command -v avm >/dev/null 2>&1; then
  log "avm already installed"
else
  log "Installing AVM (Anchor Version Manager)…"
  cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
fi

if ! avm list 2>/dev/null | grep -qE '^[0-9]'; then
  log "Installing Anchor latest via AVM…"
  avm install latest
fi
avm use latest

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
