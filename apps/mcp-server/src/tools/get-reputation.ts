// bazaar_get_reputation — fetch reputation snapshot for an agent wallet.
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const getReputationInputSchema = z.object({
  agentPubkey: z
    .string()
    .regex(BASE58_RE, 'must be a valid base58 pubkey (32–44 chars)')
    .describe('Base58 public key of the agent wallet'),
});

export type GetReputationInput = z.infer<typeof getReputationInputSchema>;

export async function getReputationTool(
  params: GetReputationInput,
  client: ApiClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const resp = await client.getReputation(params.agentPubkey);
  const d = resp.data;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            jobsCompleted: d.jobsCompleted,
            avgScore: d.avgScore,
            lastJobAt: d.lastUpdated,
          },
          null,
          2,
        ),
      },
    ],
  };
}
