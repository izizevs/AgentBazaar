// bazaar_discover — search active service listings by capability.
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export const discoverInputSchema = z.object({
  capability: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Filter by capability keyword (partial match, case-insensitive)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of results to return (default 20, max 100)'),
});

export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export async function discoverTool(
  params: DiscoverInput,
  client: ApiClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const resp = await client.getListings({
    capability: params.capability,
    limit: params.limit,
  });

  const listings = resp.data.map((item) => ({
    pubkey: item.pubkey,
    owner: item.owner,
    capability: item.capability,
    priceUsdcBaseUnits: item.priceUsdcBaseUnits,
    slaParams: item.slaParams,
    metadataUri: item.metadataUri,
    jobsCompleted: item.jobsCompleted,
    reputationScore: item.reputationScore,
  }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ listings, total: resp.pagination.total }, null, 2),
      },
    ],
  };
}
