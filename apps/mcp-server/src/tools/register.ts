// bazaar_register — build an unsigned register_service transaction.
// The MCP server is stateless and non-custodial: it constructs the tx and
// returns it base64-encoded for the LLM client to sign + broadcast.
import { buildRegisterTx } from '@agent-bazaar/sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const base58Pubkey = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      new PublicKey(v);
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid base58 public key');

const decimalBigInt = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative decimal integer string')
  .transform((v) => BigInt(v));

export const registerInputSchema = z.object({
  signerPubkey: base58Pubkey.describe('Base58 public key of the agent wallet that will sign'),
  capability: z
    .string()
    .min(1)
    .max(256)
    .describe('Human-readable capability identifier, e.g. "translate-text"'),
  priceUsdcBaseUnits: decimalBigInt.describe(
    'Price in USDC base units (6 decimals) as decimal string',
  ),
  satiAgentId: decimalBigInt.describe('SATI agent ID as decimal string; use "0" if not registered'),
  pricingModel: z
    .enum(['per_request', 'per_job', 'hourly', 'subscription'])
    .describe('Pricing model variant'),
  slaParams: z
    .object({
      maxLatencyMs: z.number().int().positive().optional(),
      minUptimePct: z.number().min(0).max(100).optional(),
      responseFormat: z.string().max(64).optional(),
      jsonSchemaUri: z.string().url().optional(),
      customParams: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .max(10)
        .optional(),
    })
    .describe('SLA parameters stored on-chain'),
  metadataUri: z
    .string()
    .min(1)
    .max(200)
    .describe('Pre-pinned metadata URI (ipfs:// CID or https:// URL, max 64 chars on-chain)'),
  rpcUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional Solana RPC endpoint override for this request'),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

export async function registerTool(
  params: RegisterInput,
  defaultRpcUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const rpcUrl = params.rpcUrl ?? defaultRpcUrl;
    const connection = new Connection(rpcUrl, 'confirmed');

    const signerPubkey = new PublicKey(params.signerPubkey);

    const { transaction, listingPubkey } = await buildRegisterTx(connection, {
      signerPubkey,
      capability: params.capability,
      priceUsdcBaseUnits: params.priceUsdcBaseUnits,
      satiAgentId: params.satiAgentId,
      pricingModel: params.pricingModel,
      slaParams: params.slaParams,
      metadataUri: params.metadataUri,
    });

    const txBase64 = Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString(
      'base64',
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              transaction: txBase64,
              metadata: {
                expectedListingPubkey: listingPubkey.toBase58(),
                signerPubkey: params.signerPubkey,
                capability: params.capability,
                pricingModel: params.pricingModel,
                priceUsdcBaseUnits: params.priceUsdcBaseUnits.toString(),
                instructions: [
                  '1. Decode the base64 transaction',
                  '2. Sign with the signerPubkey wallet',
                  '3. Broadcast to Solana',
                  '4. Confirm the listing PDA was created at expectedListingPubkey',
                ],
              },
            },
            null,
            2,
          ),
        },
      ],
    };
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
}
