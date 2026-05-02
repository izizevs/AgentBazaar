// bazaar_deliver — build an unsigned submit_delivery transaction.
// Sign-tx-on-client: MCP server constructs the tx; the LLM client (provider) signs + broadcasts.
import { buildDeliverTx } from '@agentbazaar/sdk';
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

export const deliverInputSchema = z.object({
  signerPubkey: base58Pubkey.describe('Base58 public key of the provider (seller) wallet'),
  escrowPubkey: base58Pubkey.describe('Base58 public key of the EscrowAccount PDA'),
  resultUri: z
    .string()
    .min(1)
    .max(256)
    .describe('URI pointing to the job result (e.g. ipfs://Qm... or https://...)'),
  resultHashHex: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be exactly 64 hex characters (32-byte SHA-256)')
    .describe('SHA-256 hash of the result payload as 64 hex characters'),
  rpcUrl: z
    .string()
    .url()
    .optional()
    .describe('Optional Solana RPC endpoint override for this request'),
});

export type DeliverInput = z.infer<typeof deliverInputSchema>;

export async function deliverTool(
  params: DeliverInput,
  defaultRpcUrl: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const rpcUrl = params.rpcUrl ?? defaultRpcUrl;
    const connection = new Connection(rpcUrl, 'confirmed');

    const transaction = await buildDeliverTx(connection, {
      signerPubkey: new PublicKey(params.signerPubkey),
      escrowPubkey: new PublicKey(params.escrowPubkey),
      resultUri: params.resultUri,
      resultHashHex: params.resultHashHex,
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
                signerPubkey: params.signerPubkey,
                escrowPubkey: params.escrowPubkey,
                resultUri: params.resultUri,
                resultHashHex: params.resultHashHex,
                instructions: [
                  '1. Decode the base64 transaction',
                  '2. Sign with the signerPubkey (provider) wallet',
                  '3. Broadcast to Solana',
                  '4. The buyer can now call bazaar_confirm to release USDC',
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
