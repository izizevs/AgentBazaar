// MCP Server instance with all tool registrations.
// Import once; re-use across requests (stateless per-request transport).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from './api-client.js';
import { confirmInputSchema, confirmTool } from './tools/confirm.js';
import { deliverInputSchema, deliverTool } from './tools/deliver.js';
import { discoverInputSchema, discoverTool } from './tools/discover.js';
import { getListingInputSchema, getListingTool } from './tools/get-listing.js';
import { getReputationInputSchema, getReputationTool } from './tools/get-reputation.js';
import { hireInputSchema, hireTool } from './tools/hire.js';
import { registerInputSchema, registerTool } from './tools/register.js';

const DEVNET_RPC = 'https://api.devnet.solana.com';

export function createMcpServer(client: ApiClient, rpcUrl?: string): McpServer {
  const resolvedRpc = rpcUrl ?? DEVNET_RPC;

  const server = new McpServer({
    name: 'AgentBazaar',
    version: '0.2.0',
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

  // ---- bazaar_register -------------------------------------------------------
  server.registerTool(
    'bazaar_register',
    {
      title: 'Register Agent Service',
      description:
        'Build an unsigned register_service transaction. The MCP server constructs the tx and ' +
        'returns it base64-encoded; the LLM client signs it with its own wallet and broadcasts. ' +
        'No private keys are held server-side. Returns { transaction, metadata.expectedListingPubkey }.',
      inputSchema: registerInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (params) => {
      try {
        return await registerTool(params, resolvedRpc);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- bazaar_hire -----------------------------------------------------------
  server.registerTool(
    'bazaar_hire',
    {
      title: 'Hire Agent (Create Escrow)',
      description:
        'Build an unsigned create_escrow transaction. The MCP server derives the escrow and vault ' +
        'PDAs, constructs the USDC lock instruction, and returns the unsigned tx base64-encoded. ' +
        'The LLM client signs with the buyer wallet and broadcasts. ' +
        'Returns { transaction, metadata.expectedEscrowPubkey, metadata.expectedVaultPubkey }.',
      inputSchema: hireInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (params) => {
      try {
        return await hireTool(params, resolvedRpc);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- bazaar_deliver --------------------------------------------------------
  server.registerTool(
    'bazaar_deliver',
    {
      title: 'Deliver Job Result',
      description:
        'Build an unsigned submit_delivery transaction (provider side). The MCP server constructs ' +
        'the instruction with the result URI and SHA-256 hash, and returns the unsigned tx. ' +
        'The LLM client signs with the provider wallet and broadcasts. ' +
        'Returns { transaction, metadata }.',
      inputSchema: deliverInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (params) => {
      try {
        return await deliverTool(params, resolvedRpc);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- bazaar_confirm --------------------------------------------------------
  server.registerTool(
    'bazaar_confirm',
    {
      title: 'Confirm Delivery (Release USDC)',
      description:
        'Build an unsigned confirm_delivery transaction (buyer side). The MCP server maps ' +
        'slaSeverity (0=ok, 1=minor, 2=moderate, 3=major) to a reputation score and constructs ' +
        'the instruction that releases USDC to the seller. The LLM client signs with the buyer ' +
        'wallet and broadcasts. Returns { transaction, metadata }.',
      inputSchema: confirmInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (params) => {
      try {
        return await confirmTool(params, resolvedRpc);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
