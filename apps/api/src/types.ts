// CF Worker bindings type — extends the global Env with our secrets.
export type Bindings = {
  // Neon connection string (set via `wrangler secret put DATABASE_URL`)
  DATABASE_URL: string;
  // Wrangler vars (non-secret, declared in wrangler.toml)
  APP_VERSION: string;
};
