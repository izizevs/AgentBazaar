// bazaar_confirm — build an unsigned confirm_delivery transaction.
// Sign-tx-on-client: MCP server constructs the tx; the LLM client (buyer) signs + broadcasts.
import { buildConfirmTx } from '@agentbazaar/sdk';
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

export const confirmInputSchema = z.object({
  signerPubkey: base58Pubkey.describe('Base58 public key of the buyer wallet'),
  escrowPubkey: base58Pubkey.describe('Base58 public key of the EscrowAccount PDA'),
  slaSeverity: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe('SLA severity: 0=ok (score 100), 1=minor (75), 2=moderate (50), 3=major (25)'),
  listingPubkey: base58Pubkey
    .optional()
    .describe('Optional: listing PDA to skip chain fetch (pass if known)'),
  sellerPubkey: base58Pubkey
    .optional()
    .describe('Optional: seller wallet pubkey to skip chain fetch (pass if known)'),
  rpcUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional Solana RPC endpoint override for this request'),
});

export type ConfirmInput = z.infer<typeof confirmInputSchema>;

export async function confirmTool(
  params: ConfirmInput,
  defaultRpcUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const rpcUrl = params.rpcUrl ?? defaultRpcUrl;
    const connection = new Connection(rpcUrl, 'confirmed');

    const transaction = await buildConfirmTx(connection, {
      signerPubkey: new PublicKey(params.signerPubkey),
      escrowPubkey: new PublicKey(params.escrowPubkey),
      slaSeverity: params.slaSeverity,
      listingPubkey: params.listingPubkey ? new PublicKey(params.listingPubkey) : undefined,
      sellerPubkey: params.sellerPubkey ? new PublicKey(params.sellerPubkey) : undefined,
    });

    const txBase64 = Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString(
      'base64',
    );

    const scoreMap: Record<number, number> = { 0: 100, 1: 75, 2: 50, 3: 25 };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              transaction: txBase64,
              metadata: {
                signerPubkey: params.signerPubkey,
                escrowPubkey: params.escrowPubkey,
                slaSeverity: params.slaSeverity,
                reputationScore: scoreMap[params.slaSeverity],
                instructions: [
                  '1. Decode the base64 transaction',
                  '2. Sign with the signerPubkey (buyer) wallet',
                  '3. Broadcast to Solana',
                  '4. USDC will be released to the seller upon confirmation',
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
