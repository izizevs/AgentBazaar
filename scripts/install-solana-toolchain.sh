#!/usr/bin/env bash
# Installs Solana CLI + Anchor + solana-test-validator from agave source inside the devcontainer.
#
# Why not in Dockerfile:
# - Only anchor-eng + qa-test-eng actually need these tools; spawning 5 other agents shouldn't wait 20 min.
# - Source builds on arm64-linux hit moving Rust-lint targets — easier to iterate interactively here.
# - Anza installer does not publish arm64-linux binaries as of v2.1.x.
#
# Run this ONCE when you start working with Anchor programs.
# Takes ~20–25 minutes (Rust compile of Solana + Anchor + test-validator from source).
# All binaries land in ~/.cargo/bin, backed by the `cargo-home` named volume.
# Future rebuilds of the devcontainer reuse the existing binaries.

set -euo pipefail

AGAVE_VERSION="${AGAVE_VERSION:-v2.1.14}"
ANCHOR_VERSION="${ANCHOR_VERSION:-v0.31.1}"

# agave v2.1.14 uses a polyfill for Vec::extract_if; Rust 1.87+ resolves the stable inherent
# method instead, breaking solana-unified-scheduler-pool. Pin the agave build to Rust 1.86.0,
# which pre-dates the stabilization. Other components (solana-cli, solana-keygen, anchor-cli)
# build fine on the default toolchain.
AGAVE_RUSTC="${AGAVE_RUSTC:-1.86.0}"

log() { printf "\033[1;34m[install-solana-toolchain]\033[0m %s\n" "$*"; }

# AGAVE_VERSION ships agave v2.1.x RUSTFLAGS workarounds for newer Rust toolchains.
# Bump the tag to a release with upstream fixes to drop these flags.
export RUSTFLAGS="-A dangerous_implicit_autorefs -A mismatched_lifetime_syntaxes"

install_agave_bin_default_toolchain() {
  local bin="$1"
  if command -v "${bin}" >/dev/null 2>&1; then
    log "${bin} already installed: $(${bin} --version)"
    return
  fi
  log "Installing ${bin} from agave ${AGAVE_VERSION} (source build, default toolchain)…"
  cargo install \
    --git https://github.com/anza-xyz/agave \
    --tag "${AGAVE_VERSION}" \
    "${bin}" \
    --locked
}

# --- 1. Ensure pinned Rust for the agave-validator build ---
if ! rustup toolchain list 2>/dev/null | grep -q "^${AGAVE_RUSTC}"; then
  log "Installing Rust ${AGAVE_RUSTC} (required for agave-validator build)…"
  rustup toolchain install "${AGAVE_RUSTC}" --profile minimal
fi

# --- 2. Solana CLI + keygen (from agave source) ---
# Anza does not publish arm64-linux release binaries; cargo install each sub-crate one by one.
# solana-cli takes ~5 min (first build). solana-keygen is ~2 min (shares build cache).
install_agave_bin_default_toolchain solana-cli
install_agave_bin_default_toolchain solana-keygen

# --- 3. Anchor CLI (direct cargo install, bypasses AVM) ---
# ANCHOR_VERSION pinned until end of MVP per M0 risk register — avoids IDL breakage from upgrades.
# We skip AVM because the `avm-home` docker volume has a pre-existing ownership quirk (mounted
# as root on first create) and AVM is not needed for a single pinned version. Reintroduce AVM
# once the volume is writable (Dockerfile patch applied but takes effect only after volume
# recreate).
if command -v anchor >/dev/null 2>&1 && anchor --version 2>/dev/null | grep -q "${ANCHOR_VERSION#v}"; then
  log "anchor ${ANCHOR_VERSION} already installed"
else
  log "Installing anchor-cli ${ANCHOR_VERSION} from source…"
  cargo install \
    --git https://github.com/coral-xyz/anchor \
    --tag "${ANCHOR_VERSION}" \
    anchor-cli \
    --locked
fi

# --- 4. solana-test-validator (via agave-validator crate, pinned Rust) ---
# The `solana-test-validator` binary is a [[bin]] target of the `agave-validator` crate
# (validator/src/bin/solana-test-validator.rs), despite the same-named crate being library-only.
# We build it with Rust ${AGAVE_RUSTC} (see note at top).
if command -v solana-test-validator >/dev/null 2>&1; then
  log "solana-test-validator already installed: $(solana-test-validator --version)"
else
  log "Installing solana-test-validator from agave ${AGAVE_VERSION} (pinned Rust ${AGAVE_RUSTC})…"
  cargo "+${AGAVE_RUSTC}" install \
    --git https://github.com/anza-xyz/agave \
    --tag "${AGAVE_VERSION}" \
    agave-validator \
    --bin solana-test-validator \
    --locked
fi

# --- 5. cargo-build-sbf (separate crate, not included in solana-cli) ---
# anchor build invokes `cargo build-sbf` which dispatches to this binary.
# It lives in sdk/cargo-build-sbf inside the agave checkout.
install_cargo_build_sbf() {
  if command -v cargo-build-sbf >/dev/null 2>&1; then
    log "cargo-build-sbf already installed"
    return
  fi
  local agave_src
  agave_src="$(ls -d "${HOME}/.cargo/git/checkouts/agave-"*/* 2>/dev/null | head -1)"
  if [[ -z "${agave_src}" || ! -d "${agave_src}/sdk/cargo-build-sbf" ]]; then
    log "warn: agave source checkout not found; skipping cargo-build-sbf install"
    return
  fi
  log "Installing cargo-build-sbf from local agave checkout…"
  cargo install --path "${agave_src}/sdk/cargo-build-sbf" --locked
}
install_cargo_build_sbf

# --- 6. SBF platform-tools (aarch64 fix) ---
# cargo-build-sbf downloads platform-tools on first use into ~/.cache/solana/<version>/.
# The upstream install.sh arch-detection uses `arm64*` but `uname -m` on Linux returns
# `aarch64`, not `arm64`, so it falls through to x86_64 — breaking the build with:
#   "OrbStack ERROR: Dynamic loader not found: /lib64/ld-linux-x86-64.so.2"
# Fix: pre-seed the cache with the correct aarch64 tarball so cargo-build-sbf never
# triggers the broken download.
install_platform_tools_aarch64() {
  local arch
  arch="$(uname -m)"
  [[ "${arch}" == "aarch64" ]] || return 0  # x86_64 downloads correctly already

  # Determine the platform-tools version cargo-build-sbf expects by reading the
  # install.sh inside the agave checkout (the version= line near `platform-tools`).
  local agave_src pt_version
  agave_src="$(ls -d "${HOME}/.cargo/git/checkouts/agave-"*/* 2>/dev/null | head -1)"
  pt_version="$(grep -A2 'platform-tools' "${agave_src}/sdk/sbf/scripts/install.sh" 2>/dev/null \
    | grep '^version=' | head -1 | cut -d= -f2)"
  [[ -n "${pt_version}" ]] || { log "warn: cannot determine platform-tools version; skipping pre-seed"; return; }

  local cache_dir="${HOME}/.cache/solana/${pt_version}/platform-tools"
  if [[ -x "${cache_dir}/rust/bin/rustc" ]]; then
    log "platform-tools ${pt_version} (aarch64) already in cache"
    return
  fi

  log "Pre-seeding aarch64 platform-tools ${pt_version} into cache…"
  local url="https://github.com/anza-xyz/platform-tools/releases/download/${pt_version}/platform-tools-linux-aarch64.tar.bz2"
  local tmp
  tmp="$(mktemp -d)"
  wget -q --show-progress -O "${tmp}/pt.tar.bz2" "${url}"

  # The tarball extracts as llvm/ rust/ version.md — wrap in platform-tools/
  mkdir -p "${cache_dir}"
  tar --strip-components 0 -jxf "${tmp}/pt.tar.bz2" -C "${cache_dir}"
  rm -rf "${tmp}"

  # If the tarball used a nested dir, flatten it
  if [[ ! -x "${cache_dir}/rust/bin/rustc" && -d "${cache_dir}/platform-tools" ]]; then
    mv "${cache_dir}/platform-tools/"* "${cache_dir}/"
    rmdir "${cache_dir}/platform-tools"
  fi

  log "platform-tools ${pt_version} (aarch64) cached at ${cache_dir}"
}
install_platform_tools_aarch64

# --- 7. cargo-build-sbf SDK scripts (strip.sh / env.sh) ---
# `cargo install solana-cli` deposits the binary but not the sdk/sbf/ tree that
# cargo-build-sbf reads for post-link stripping. Symlink from the agave source
# checkout (already on disk after step 2) to the path cargo-build-sbf expects.
# Retained from PR #2 (ADR-0001) — needed if an agent ever rebuilds the program
# from source via `anchor build` / `cargo build-sbf` inside this container.
install_sbf_sdk_links() {
  local agave_src
  agave_src="$(ls -d "${HOME}/.cargo/git/checkouts/agave-"*/* 2>/dev/null | head -1)"
  if [[ -z "${agave_src}" || ! -d "${agave_src}/sdk/sbf" ]]; then
    log "warn: agave source checkout not found; skipping sdk/sbf linking"
    return
  fi
  mkdir -p "${HOME}/.cargo/bin/sdk/sbf"
  [[ -e "${HOME}/.cargo/bin/sdk/sbf/scripts" ]] || \
    ln -s "${agave_src}/sdk/sbf/scripts" "${HOME}/.cargo/bin/sdk/sbf/scripts"
  [[ -e "${HOME}/.cargo/bin/sdk/sbf/env.sh" ]] || \
    ln -s "${agave_src}/sdk/sbf/env.sh" "${HOME}/.cargo/bin/sdk/sbf/env.sh"
  log "sdk/sbf scripts linked from ${agave_src}"
}
install_sbf_sdk_links

# --- 6. Summary ---
log "Done."
echo
echo "solana:                $(solana --version)"
echo "solana-keygen:         $(solana-keygen --version)"
echo "solana-test-validator: $(solana-test-validator --version)"
echo "anchor:                $(anchor --version)"
echo
echo "Reminder: after any 'cargo update' inside programs/, re-run ./scripts/pin-sbf-toolchain-deps.sh"
echo "          so transitive crates stay compatible with platform-tools rustc 1.79."
