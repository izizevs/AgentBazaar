#!/usr/bin/env bash
# Pins transitive crates in programs/Cargo.lock to versions compatible with
# the rustc bundled in solana-cargo-build-sbf (currently 1.79.0 in
# platform-tools v1.43). Newer crate releases have bumped MSRV past 1.79 or
# require the edition2024 cargo feature, which breaks `anchor build` /
# `cargo build-sbf`.
#
# Run after any `cargo update` / dependency refresh that touches
# programs/Cargo.lock. Idempotent; only changes what's out of policy.
#
# Track upstream fixes and remove pins once the toolchain bundles a newer
# rustc that covers edition2024.

set -euo pipefail

cd "$(dirname "$0")/../programs"

log() { printf "\033[1;34m[pin-sbf-deps]\033[0m %s\n" "$*"; }

pin() {
  local spec="$1"
  local version="$2"
  log "pin ${spec} -> ${version}"
  cargo update -p "${spec}" --precise "${version}" >/dev/null 2>&1 || {
    log "  (skipped — ${spec} not in lockfile or constraint unsatisfiable)"
  }
}

# Breaking on rustc 1.79 / edition2024:
pin blake3 1.5.5                 # 1.8.x pulls digest 0.11 -> block-buffer 0.12 (edition2024)
pin proc-macro-crate@3.5.0 3.2.0 # 3.5 pulls toml_edit 0.25 / toml_parser 1.1 (edition2024)
pin indexmap 2.9.0               # 2.14 requires edition2024 via hashbrown 0.17
pin unicode-segmentation 1.12.0  # 1.13 requires rustc >=1.85

log "done. Re-run cargo build-sbf to verify."
