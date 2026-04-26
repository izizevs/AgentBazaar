// CF Worker bindings for the MCP server.
export type Bindings = {
  // Shared Bearer token for LLM agent clients (set via `wrangler secret put MCP_AUTH_TOKEN`)
  MCP_AUTH_TOKEN: string;
  // Base URL of the Discovery REST API (default set in wrangler.toml vars)
  API_URL: string;
  // Wrangler vars (non-secret, declared in wrangler.toml)
  APP_VERSION: string;
};
