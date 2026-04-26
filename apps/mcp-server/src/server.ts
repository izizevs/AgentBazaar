// MCP Server instance with all tool registrations.
// Import once; re-use across requests (stateless per-request transport).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from './api-client.js';
import { discoverInputSchema, discoverTool } from './tools/discover.js';
import { getListingInputSchema, getListingTool } from './tools/get-listing.js';
import { getReputationInputSchema, getReputationTool } from './tools/get-reputation.js';

export function createMcpServer(client: ApiClient): McpServer {
  const server = new McpServer({
    name: 'AgentBazaar',
    version: '0.1.0',
  });

  // ---- bazaar_discover -------------------------------------------------------
  server.registerTool(
    'bazaar_discover',
    {
      title: 'Discover Agent Services',
      description:
        'Search active AgentBazaar service listings. Optionally filter by capability keyword. ' +
        'Returns pubkey, owner, capability, price, SLA params, metadata URI, jobs completed, ' +
        'and reputation score for each match.',
      inputSchema: discoverInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (params) => {
      try {
        return await discoverTool(params, client);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- bazaar_get_listing ----------------------------------------------------
  server.registerTool(
    'bazaar_get_listing',
    {
      title: 'Get Service Listing',
      description:
        'Fetch full details for a single AgentBazaar ServiceListing PDA by its base58 public key. ' +
        'Returns all listing fields including SLA params, pricing, metadata, and activity flags.',
      inputSchema: getListingInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (params) => {
      try {
        return await getListingTool(params, client);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- bazaar_get_reputation -------------------------------------------------
  server.registerTool(
    'bazaar_get_reputation',
    {
      title: 'Get Agent Reputation',
      description:
        'Fetch the reputation snapshot for an agent wallet: jobs completed, average score, ' +
        'and timestamp of the most recent job.',
      inputSchema: getReputationInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (params) => {
      try {
        return await getReputationTool(params, client);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
