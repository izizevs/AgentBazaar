// AgentBazaar MCP Server — Cloudflare Workers entry point
//
// Endpoints:
//   GET  /healthz   — unauthed health check
//   POST /mcp       — MCP-over-HTTP (tools/list, tools/call, …); requires Bearer token
//
// Auth: Authorization: Bearer <MCP_AUTH_TOKEN>
// Protocol: MCP Streamable HTTP (stateless per-request transport)
//
// The MCP server delegates all data to the Discovery REST API at API_URL.
// No direct DB access from this worker.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { ApiClient } from './api-client.js';
import { extractBearerToken, validateToken } from './auth.js';
import { createMcpServer } from './server.js';
import type { Bindings } from './types.js';

const app = new Hono<{ Bindings: Bindings }>();

// ---- Health check (unauthed) -----------------------------------------------

const startTime = Date.now();

app.get('/healthz', (c) => {
  const version = c.env.APP_VERSION ?? 'unknown';
  return c.json({
    ok: true,
    service: 'agentbazaar-mcp',
    version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// ---- MCP endpoint -----------------------------------------------------------

app.all('/mcp', async (c) => {
  // 1. Auth gate
  const expectedToken = c.env.MCP_AUTH_TOKEN ?? '';
  if (!expectedToken) {
    // Misconfigured worker — fail closed
    return c.json({ error: 'server_misconfigured', message: 'MCP_AUTH_TOKEN is not set' }, 500);
  }

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(
      { error: 'unauthorized', message: 'Missing Authorization: Bearer <token> header' },
      401,
    );
  }
  if (!validateToken(token, expectedToken)) {
    return c.json({ error: 'unauthorized', message: 'Invalid Bearer token' }, 401);
  }

  // 2. Build per-request client + server (stateless: no session state in CF Workers)
  const apiUrl = c.env.API_URL ?? 'https://agentbazaar-api.r-443.workers.dev';
  const rpcUrl = c.env.RPC_URL ?? 'https://api.devnet.solana.com';
  const client = new ApiClient(apiUrl);
  const mcpServer: McpServer = createMcpServer(client, rpcUrl);

  // 3. Stateless transport — one per request, no session ID
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);

  // 4. Parse body once for POST requests, then hand to transport.
  //    GET/DELETE requests have no body; passing parsedBody: undefined is fine.
  let parsedBody: unknown;
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      return c.json(
        { error: 'bad_request', message: 'Content-Type must be application/json for POST /mcp' },
        400,
      );
    }
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: 'Request body must be valid JSON' }, 400);
    }
  }

  return transport.handleRequest(c.req.raw, parsedBody !== undefined ? { parsedBody } : undefined);
});

// ---- 404 fallback -----------------------------------------------------------

app.notFound((c) =>
  c.json({ error: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }, 404),
);

// ---- Error handler ----------------------------------------------------------

app.onError((err, c) => {
  console.error('[mcp-server] unhandled error', err);
  return c.json({ error: 'internal_error', message: 'An unexpected error occurred' }, 500);
});

export default app;
