# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# Stage 1 — builder
# Runs pnpm install + tsc from the monorepo root so workspace
# package resolution (e.g. @agentbazaar/idl) works correctly.
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Install pnpm via corepack (matches packageManager field in root package.json)
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Install curl (used in HEALTHCHECK)
RUN apk add --no-cache curl

WORKDIR /build

# Copy workspace manifests first for layer-cache efficiency.
# pnpm --frozen-lockfile validates against ALL workspace members, so every
# package.json referenced by pnpm-workspace.yaml must exist before install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/idl/package.json ./packages/idl/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/indexer/package.json ./apps/indexer/
COPY apps/api/package.json ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY tests/package.json ./tests/
# tsconfig.base.json lives at monorepo root
COPY tsconfig.base.json ./

# Install all workspace deps (filter notation drops some transitive deps)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/idl/ ./packages/idl/
COPY apps/indexer/ ./apps/indexer/

# Build IDL package first (indexer depends on it at runtime via compiled JS)
RUN cd packages/idl && npx tsc --project tsconfig.json

# Build indexer (tsc emits to apps/indexer/dist/)
RUN pnpm --filter @agentbazaar/indexer build

# ─────────────────────────────────────────────────────────────
# Stage 2 — runtime
# Minimal image: only compiled JS + production node_modules.
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# curl is required by the HEALTHCHECK instruction below
RUN apk add --no-cache curl

WORKDIR /app

# Copy workspace manifests needed for production install — same set as builder
# stage because pnpm validates the entire workspace against the lockfile.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY tsconfig.base.json ./
COPY packages/idl/package.json ./packages/idl/
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/indexer/package.json ./apps/indexer/
COPY apps/api/package.json ./apps/api/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY tests/package.json ./tests/

# Production deps only (no devDependencies)
RUN pnpm install --frozen-lockfile --filter @agentbazaar/indexer... --prod

# Copy compiled output from builder
COPY --from=builder /build/apps/indexer/dist/ ./apps/indexer/dist/

# Copy compiled IDL (dist/) — Node.js will load .js not .ts
COPY --from=builder /build/packages/idl/dist/ ./packages/idl/dist/
# IDL JSON files needed at runtime
COPY --from=builder /build/packages/idl/idl/ ./packages/idl/idl/

# Patch IDL package.json exports to point to compiled dist/ instead of src/ .ts files.
# This ensures Node ESM resolution finds .js files, not .ts sources.
RUN node -e "var fs=require('fs');var p='./packages/idl/package.json';var pkg=JSON.parse(fs.readFileSync(p,'utf8'));pkg.main='./dist/index.js';pkg.types='./dist/index.d.ts';pkg.exports={'.':{types:'./dist/index.d.ts',import:'./dist/index.js'},'./generated':{types:'./dist/generated/index.d.ts',import:'./dist/generated/index.js'},'./bazaar-registry.json':'./idl/bazaar_registry.json'};fs.writeFileSync(p,JSON.stringify(pkg,null,2));console.log('IDL package.json patched to use dist/');"

EXPOSE 3001

# Non-root for security
USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3001/healthz || exit 1

CMD ["node", "apps/indexer/dist/index.js"]
