// bazaar_get_listing — fetch full detail for a single ServiceListing PDA.
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const getListingInputSchema = z.object({
  pubkey: z
    .string()
    .regex(BASE58_RE, 'must be a valid base58 pubkey (32–44 chars)')
    .describe('Base58 public key of the ServiceListing PDA'),
});

export type GetListingInput = z.infer<typeof getListingInputSchema>;

export async function getListingTool(
  params: GetListingInput,
  client: ApiClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const resp = await client.getListing(params.pubkey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(resp.data, null, 2),
      },
    ],
  };
}
