/**
 * E2E: dispute path — register → hire → dispute → vault refunded to buyer.
 * Hits devnet directly. Guarded by E2E=true env var.
 *
 * Run: E2E=true pnpm --filter @agentbazaar/tests test:e2e
 *
 * M1 stub: dispute triggers immediate full refund to buyer (no arbitration).
 * Task #30 / R4 (Task #50).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentBazaar, EscrowAlreadyResolvedError } from '@agentbazaar/sdk';
import { Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVNET_USDC_MINT } from '../fixtures/usdc-mint.js';
import { createFundedWallets, type FundedWallet, fundUsdc } from '../fixtures/wallets.js';
import { assertEscrowState, assertVaultBalance } from '../helpers/escrow-assertions.js';

function loadCliPayer(): Keypair | undefined {
  try {
    const keyPath = join(homedir(), '.config', 'solana', 'id.json');
    const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
    return Keypair.fromSecretKey(secret);
  } catch {
    return undefined;
  }
}

const isE2E = process.env.E2E === 'true';

const BUDGET = 750_000n; // 0.75 USDC

describe.skipIf(!isE2E)('E2E: escrow dispute path', { timeout: 180_000 }, () => {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const pinataJwt = process.env.PINATA_JWT ?? '';

  const capability = `e2e-escrow-dispute-${Date.now()}`;

  let connection: Connection;
  let buyerWallet: FundedWallet;
  let sellerWallet: FundedWallet;
  let buyerBazaar: AgentBazaar;
  let sellerBazaar: AgentBazaar;
  let listingPda: PublicKey;
  let disputedEscrowPda: PublicKey;
  let disputedVaultPda: PublicKey;

  beforeAll(async () => {
    connection = new Connection(rpcUrl, 'confirmed');
    const payer = loadCliPayer();
    const funded = await createFundedWallets(connection, 2, { payer });
    buyerWallet = funded[0]!;
    sellerWallet = funded[1]!;

    // Load the master keypair (same as CLI payer) to fund USDC from its balance.
    const master =
      payer ??
      (() => {
        throw new Error('Master keypair not found — check ~/.config/solana/id.json');
      })();

    // Fund buyer with 1.5 USDC (one escrow at 0.75 USDC + slop).
    await fundUsdc(connection, master, buyerWallet.publicKey, 1_500_000n);
    // Create seller ATA (0 USDC) so it is ready to receive if needed.
    await fundUsdc(connection, master, sellerWallet.publicKey, 0n);

    const usdcMintStr = DEVNET_USDC_MINT.toBase58();

    sellerBazaar = new AgentBazaar({
      wallet: new Wallet(sellerWallet.keypair),
      rpc: connection,
      pinataJwt,
      discoveryApiUrl: 'http://localhost:9999',
      usdcMint: usdcMintStr,
    });

    buyerBazaar = new AgentBazaar({
      wallet: new Wallet(buyerWallet.keypair),
      rpc: connection,
      pinataJwt: '',
      discoveryApiUrl: 'http://localhost:9999',
      usdcMint: usdcMintStr,
    });

    const registered = await sellerBazaar.register({
      name: 'E2E Dispute Agent',
      description: 'Dispute path test agent.',
      capability,
      priceUsdc: BUDGET,
      pricingModel: 'per_request',
      sla: { maxLatencyMs: 5000 },
      endpoint: 'https://e2e-dispute.agentbazaar.local/api',
    });
    listingPda = registered.listing;
  }, 180_000);

  it('dispute() transitions escrow to Disputed and refunds buyer', async () => {
    const buyerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, buyerWallet.publicKey);
    const buyerBalanceBefore = BigInt(
      (await connection.getTokenAccountBalance(buyerAta)).value.amount,
    );

    const handle = await buyerBazaar.hire(listingPda.toBase58(), {
      budget: BUDGET,
      sla: { maxLatencyMs: 5000 },
      timeout: 3600,
      nonce: BigInt(Date.now()),
    });
    disputedEscrowPda = handle.escrowPda;
    disputedVaultPda = handle.vaultPda;

    // Vault is funded after hire
    await assertVaultBalance(connection, disputedVaultPda, BUDGET);

    await buyerBazaar.dispute(disputedEscrowPda.toBase58(), {
      reason: 'Agent delivered incorrect output format',
      evidenceUri:
        'ipfs://bafyreie4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e/evidence.json',
    });

    await assertEscrowState(connection, disputedEscrowPda, 'disputed');
    // M1 stub: full refund to buyer on dispute
    await assertVaultBalance(connection, disputedVaultPda, 0n);

    const buyerBalanceAfter = BigInt(
      (await connection.getTokenAccountBalance(buyerAta)).value.amount,
    );
    // Buyer gets back the budget (net of USDC spent on hire)
    expect(buyerBalanceAfter - (buyerBalanceBefore - BUDGET)).toBe(BUDGET);
  });

  it('negative: deliver() after dispute throws EscrowAlreadyResolvedError', async () => {
    // disputedEscrowPda is already in Disputed state from the test above
    const resultHash = new Uint8Array(32).fill(0xef);
    await expect(
      sellerBazaar.deliver(disputedEscrowPda.toBase58(), {
        resultUri: 'ipfs://bafyreie5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e/late.json',
        resultHash,
      }),
    ).rejects.toThrow(EscrowAlreadyResolvedError);
  });

  afterAll(async () => {
    // Devnet test state is ephemeral and harmless; no cleanup required.
  });
});
