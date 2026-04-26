import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { z } from 'zod';
import type { AnchorWallet } from './client.js';
import {
  EscrowAlreadyExistsError,
  InsufficientFundsError,
  InvalidListingError,
  ValidationError,
} from './errors.js';
import {
  DEVNET_USDC_MINT,
  getAssociatedTokenAddress,
  getEscrowProgramId,
  makeEscrowProgram,
  sendWithRetry,
} from './escrow-utils.js';
import type { EscrowHandle, HireInput } from './types.js';

const HireInputSchema = z.object({
  budget: z.bigint().refine((v) => v > 0n, 'budget must be positive'),
  sla: z.object({
    maxLatencyMs: z.number().int().positive().optional(),
    minUptimePct: z.number().optional(),
    responseFormat: z.string().optional(),
    jsonSchemaUri: z.string().optional(),
    customParams: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  }),
  timeout: z.number().int().positive('timeout must be a positive number of seconds'),
  nonce: z.bigint().optional(),
});

export async function hireAgent(
  connection: Connection,
  wallet: AnchorWallet,
  agentId: string,
  input: HireInput,
  usdcMint: PublicKey = DEVNET_USDC_MINT,
): Promise<EscrowHandle> {
  const parsed = HireInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message);

  let listingPubkey: PublicKey;
  try {
    listingPubkey = new PublicKey(agentId);
  } catch {
    throw new InvalidListingError(agentId);
  }

  const nonce = input.nonce ?? BigInt(Date.now());
  const nonceBuf = new BN(nonce.toString()).toArrayLike(Buffer, 'le', 8);

  const escrowProgramId = getEscrowProgramId(connection);

  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), wallet.publicKey.toBuffer(), listingPubkey.toBuffer(), nonceBuf],
    escrowProgramId,
  );

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), escrowPda.toBuffer()],
    escrowProgramId,
  );

  const program = makeEscrowProgram(connection, wallet);

  const existing = await program.account.escrowAccount.fetchNullable(escrowPda);
  if (existing) {
    if (!('created' in existing.state)) {
      throw new EscrowAlreadyExistsError(escrowPda.toBase58());
    }
    return { escrowPda, vaultPda, signature: '' };
  }

  const buyerTokenAccount = getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  const tokenBalance = await connection.getTokenAccountBalance(buyerTokenAccount);
  const available = BigInt(tokenBalance.value.amount);
  if (available < input.budget) {
    throw new InsufficientFundsError(input.budget, available);
  }

  const ix = await program.methods
    .createEscrow(
      new BN(input.budget.toString()),
      input.sla.maxLatencyMs ?? null,
      input.sla.responseFormat ?? null,
      new BN(input.timeout), // relative seconds; on-chain adds Clock.unix_timestamp
      new BN(nonce.toString()),
    )
    .accounts({
      buyer: wallet.publicKey,
      listing: listingPubkey,
      buyerTokenAccount,
    })
    .instruction();

  const signature = await sendWithRetry(connection, wallet, ix);
  return { escrowPda, vaultPda, signature };
}
