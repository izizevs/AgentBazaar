# ADR 0001 — cargo-build-sbf toolchain workarounds (platform-tools v1.43 / rustc 1.79)

Date: 2026-04-24
Status: Accepted
Authors: anchor-eng

## Context

`anchor build` / `cargo build-sbf` in agave v2.1.14 ships platform-tools v1.43,
which bundles **rustc 1.79.0**. Modern crate releases from the broader
ecosystem have started gating on:

1. the `edition2024` cargo feature (unstable on < 1.85), and
2. explicit MSRV bumps (e.g. `unicode-segmentation` ≥ 1.13 requires 1.85).

When `solana-program 2.3` or its transitive deps resolve to the latest
semver-compatible releases, the SBF compile fails with errors like:

```
feature `edition2024` is required
rustc 1.79.0-dev is not supported by the following package
```

On top of that, `cargo install` of agave's `solana-cli` / `solana-keygen`
crates installs the binaries but not the `sdk/sbf/` script tree that
`cargo-build-sbf` invokes for post-link stripping (`strip.sh`, `env.sh`).
Without those files, compilation succeeds but stripping fails non-fatally,
leaving warnings like `strip.sh: No such file or directory`.

## Decision

Two layered workarounds, codified in `scripts/`:

1. **`scripts/pin-sbf-toolchain-deps.sh`** — idempotent `cargo update --precise`
   pins to hold specific transitive crates at rustc-1.79-compatible versions:

   | crate                     | pinned version | reason                                    |
   |---------------------------|----------------|-------------------------------------------|
   | `blake3`                  | `1.5.5`        | 1.8.x pulls `digest 0.11` → `block-buffer 0.12` (edition2024) |
   | `proc-macro-crate@3.5`    | `3.2.0`        | 3.5 pulls `toml_edit 0.25` / `toml_parser 1.1` (edition2024) |
   | `indexmap`                | `2.9.0`        | 2.14 requires edition2024 via `hashbrown 0.17` |
   | `unicode-segmentation`    | `1.12.0`       | 1.13 requires rustc ≥ 1.85                |

   Run after any dependency refresh inside `programs/`.

2. **`scripts/install-solana-toolchain.sh`** now symlinks the missing
   `sdk/sbf/scripts/` and `sdk/sbf/env.sh` into `~/.cargo/bin/sdk/sbf/` from
   the agave source checkout that `cargo install` leaves in
   `~/.cargo/git/checkouts/agave-*/`.

Both are committed so CI and fresh dev environments reproduce the exact
working toolchain.

## Sunset

Remove both workarounds once platform-tools bundles a rustc ≥ 1.85 and the
agave installer drops the SDK scripts in the expected path. Track upstream
agave releases past v2.1.14.

## References

- `scripts/install-solana-toolchain.sh`
- `scripts/pin-sbf-toolchain-deps.sh`
- upstream cargo-build-sbf: https://github.com/anza-xyz/agave/tree/master/sdk/cargo-build-sbf
