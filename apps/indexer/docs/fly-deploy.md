# Fly.io deployment guide — agentbazaar-indexer

The indexer runs as a persistent service on Fly.io (`ams` region) so webhook delivery
is not tied to the developer's laptop.

**App URL:** `https://agentbazaar-indexer.fly.dev`
**Region:** `ams` (Amsterdam, close to Helius Frankfurt)
**Machine type:** shared-cpu-1x / 512 MB RAM

---

## First-time deploy

Prerequisites: `flyctl` installed + `FLY_API_TOKEN` in `/workspace/.env`.

Run all commands from the **monorepo root** (`/workspace`):

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

# 2. Authenticate
export FLY_API_TOKEN=$(grep FLY_API_TOKEN /workspace/.env | cut -d= -f2-)
flyctl auth whoami   # should print the token owner

# 3. Create the app (once)
flyctl apps create agentbazaar-indexer --org personal

# 4. Stage secrets (pull values from .env)
flyctl secrets set \
  DATABASE_URL="..." \
  HELIUS_API_KEY="..." \
  HELIUS_WEBHOOK_SECRET="..." \
  PINATA_JWT="..." \
  BAZAAR_REGISTRY_PROGRAM_ID="ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3" \
  BAZAAR_ESCROW_PROGRAM_ID="EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2" \
  NODE_ENV="production" \
  --app agentbazaar-indexer

# 5. Deploy (build happens on Fly's remote builders)
flyctl deploy \
  --app agentbazaar-indexer \
  --config apps/indexer/fly.toml \
  --dockerfile apps/indexer/Dockerfile \
  --remote-only
```

---

## Redeployment (code change)

```bash
# From monorepo root — same command as initial deploy
flyctl deploy \
  --app agentbazaar-indexer \
  --config apps/indexer/fly.toml \
  --dockerfile apps/indexer/Dockerfile \
  --remote-only
```

Fly uses a rolling update strategy: the existing machine is updated in-place with
the new image. Health checks must pass before the deploy is considered successful.

---

## View logs

```bash
# Stream live logs
flyctl logs -a agentbazaar-indexer

# One-shot (no tail)
flyctl logs -a agentbazaar-indexer --no-tail
```

Logs are pino JSON in production. Look for `"msg":"indexer listening"` on startup
and `"msg":"retention: processed_signatures cleanup complete"` from the cron.

---

## Health check

```bash
curl https://agentbazaar-indexer.fly.dev/healthz
# Expected: {"ok":true,"version":"0.1.0","uptime":<seconds>}
```

Fly also polls `/healthz` internally every 15 seconds. The machine shows
`1 passing` in `flyctl status` when healthy.

---

## Scale / resize

The minimum machine count is set to 1 in `fly.toml` (`min_machines_running = 1`).
Do NOT lower this — webhook delivery will silently fail if the machine is stopped.

To upgrade the VM size:

```bash
flyctl machine update d899732a2d2068 --vm-size shared-cpu-2x --app agentbazaar-indexer
```

---

## Update secrets

```bash
flyctl secrets set NEW_SECRET="value" --app agentbazaar-indexer
# Secrets take effect on next machine restart/deploy
```

---

## Common errors

| Symptom | Fix |
|---|---|
| `Cannot find module '...dist/index.js'` | Entry point mismatch — verify `CMD` in Dockerfile matches tsc `outDir` + `rootDir` |
| `ERR_MODULE_NOT_FOUND` for `@agent-bazaar/idl` | IDL package not built to `dist/` — check builder step `RUN cd packages/idl && npx tsc` |
| Health check warning in `flyctl status` | Machine is starting or crashed — run `flyctl logs` to diagnose |
| `401 Unauthorized` in webhook handler | `HELIUS_WEBHOOK_SECRET` secret doesn't match Helius dashboard auth header |
| Machine in `stopped` state | App crashed on startup — check logs; machine will NOT auto-restart after 10 failures |

---

## Architecture notes

The Dockerfile uses a **two-stage build** from the monorepo root:

- **Stage 1 (builder):** pnpm installs full deps, builds `@agent-bazaar/idl` (tsc) then
  `@agent-bazaar/indexer` (tsc). Both must be compiled because the IDL package ships
  TypeScript source only and Node ESM cannot load `.ts` files at runtime.
- **Stage 2 (runtime):** copies compiled `dist/` from both packages, installs
  production deps only, patches IDL `package.json` exports to point to `dist/` so
  Node resolves `.js` files, then runs as non-root `node` user.

Build context must be the **monorepo root** (not `apps/indexer/`) so the builder
stage can access `pnpm-workspace.yaml`, `packages/idl/`, and `tsconfig.base.json`.
