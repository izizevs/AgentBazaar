// bazaar_hire — build an unsigned create_escrow transaction.
// Sign-tx-on-client: MCP server constructs the tx; the LLM client signs + broadcasts.
import { buildHireTx } from '@agentbazaar/sdk';
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

const VALID_TIMEOUTS = [86400, 172800, 259200, 604800] as const;

export const hireInputSchema = z.object({
  buyerPubkey: base58Pubkey.describe('Base58 public key of the buyer wallet'),
  listingPubkey: base58Pubkey.describe('Base58 public key of the ServiceListing PDA to hire'),
  budgetUsdcBaseUnits: decimalBigInt.describe('Budget in USDC base units as decimal string'),
  timeoutSeconds: z
    .number()
    .int()
    .refine((v) => (VALID_TIMEOUTS as readonly number[]).includes(v), {
      message: 'timeoutSeconds must be one of: 86400, 172800, 259200, 604800',
    })
    .describe('Escrow timeout in seconds: 86400 (1d), 172800 (2d), 259200 (3d), 604800 (7d)'),
  slaTerms: z
    .object({
      maxLatencyMs: z.number().int().positive().optional(),
      minUptimePct: z.number().min(0).max(100).optional(),
      responseFormat: z.string().max(64).optional(),
    })
    .optional()
    .describe('SLA terms agreed for this job'),
  nonce: decimalBigInt
    .optional()
    .describe('Optional nonce for PDA derivation; generated from timestamp if absent'),
  rpcUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional Solana RPC endpoint override for this request'),
});

export type HireInput = z.infer<typeof hireInputSchema>;

export async function hireTool(
  params: HireInput,
  defaultRpcUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const rpcUrl = params.rpcUrl ?? defaultRpcUrl;
    const connection = new Connection(rpcUrl, 'confirmed');

    const nonce = params.nonce ?? BigInt(Date.now());

    const { transaction, escrowPubkey, vaultPubkey } = await buildHireTx(connection, {
      buyerPubkey: new PublicKey(params.buyerPubkey),
      listingPubkey: new PublicKey(params.listingPubkey),
      budgetUsdcBaseUnits: params.budgetUsdcBaseUnits,
      timeoutSeconds: params.timeoutSeconds,
      slaParams: params.slaTerms ?? {},
      nonce,
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
                expectedEscrowPubkey: escrowPubkey.toBase58(),
                expectedVaultPubkey: vaultPubkey.toBase58(),
                buyerPubkey: params.buyerPubkey,
                listingPubkey: params.listingPubkey,
                budgetUsdcBaseUnits: params.budgetUsdcBaseUnits.toString(),
                nonce: nonce.toString(),
                timeoutSeconds: params.timeoutSeconds,
                instructions: [
                  '1. Decode the base64 transaction',
                  '2. Sign with the buyerPubkey wallet',
                  '3. Ensure buyer token account has sufficient USDC',
                  '4. Broadcast to Solana',
                  '5. Confirm the escrow PDA was created at expectedEscrowPubkey',
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
