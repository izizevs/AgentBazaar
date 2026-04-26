/**
 * E2E: timeout path — register → hire → deliver → wait → claimTimeout.
 * Hits devnet directly. Guarded by E2E=true env var.
 *
 * Run: E2E=true pnpm --filter @agentbazaar/tests test:e2e
 *
 * Uses a 30-second timeout and a real wait. Would have caught H1 immediately:
 * if the deadline were set as an absolute timestamp (~year 2080) instead of
 * Clock.unix_timestamp + timeout, claimTimeout would fail with EscrowNotExpiredError
 * after our 35-second wait.
 *
 * Task #29 / R4 (Task #50).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentBazaar, EscrowNotExpiredError } from '@agentbazaar/sdk';
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

const BUDGET = 500_000n; // 0.5 USDC
const RESULT_HASH = new Uint8Array(32).fill(0xcd);
const RESULT_URI = 'ipfs://bafyreie3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e/timeout.json';

describe.skipIf(!isE2E)('E2E: escrow timeout path', { timeout: 180_000 }, () => {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const pinataJwt = process.env.PINATA_JWT ?? '';

  const capability = `e2e-escrow-timeout-${Date.now()}`;

  let connection: Connection;
  let buyerWallet: FundedWallet;
  let sellerWallet: FundedWallet;
  let buyerBazaar: AgentBazaar;
  let sellerBazaar: AgentBazaar;
  let listingPda: PublicKey;

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

    // Fund buyer with 1.5 USDC (two escrows at 0.5 USDC each + slop).
    await fundUsdc(connection, master, buyerWallet.publicKey, 1_500_000n);
    // Create seller ATA (0 USDC) so it is ready to receive on claimTimeout().
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
      name: 'E2E Timeout Agent',
      description: 'Timeout path test agent.',
      capability,
      priceUsdc: BUDGET,
      pricingModel: 'per_request',
      sla: { maxLatencyMs: 5000 },
      endpoint: 'https://e2e-timeout.agentbazaar.local/api',
    });
    listingPda = registered.listing;
  }, 180_000);

  it('negative: claimTimeout before deadline throws EscrowNotExpiredError', async () => {
    // Use a long timeout so deadline will not be reached in this test.
    const longHandle = await buyerBazaar.hire(listingPda.toBase58(), {
      budget: BUDGET,
      sla: { maxLatencyMs: 5000 },
      timeout: 3600,
      nonce: BigInt(Date.now()) + 1n,
    });

    await sellerBazaar.deliver(longHandle.escrowPda.toBase58(), {
      resultUri: RESULT_URI,
      resultHash: RESULT_HASH,
    });

    await expect(sellerBazaar.claimTimeout(longHandle.escrowPda.toBase58())).rejects.toThrow(
      EscrowNotExpiredError,
    );
  });

  it('claimTimeout succeeds after deadline elapses', async () => {
    const handle = await buyerBazaar.hire(listingPda.toBase58(), {
      budget: BUDGET,
      sla: { maxLatencyMs: 5000 },
      timeout: 30, // 30-second window — if H1 were present this would be ~year 2080
      nonce: BigInt(Date.now()) + 2n,
    });

    await sellerBazaar.deliver(handle.escrowPda.toBase58(), {
      resultUri: RESULT_URI,
      resultHash: RESULT_HASH,
    });

    await assertEscrowState(connection, handle.escrowPda, 'delivered');

    // Wait for the 30-second deadline to pass (5-second buffer for devnet lag)
    await new Promise((resolve) => setTimeout(resolve, 35_000));

    const sellerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, sellerWallet.publicKey);
    const sellerBalanceBefore = BigInt(
      (await connection.getTokenAccountBalance(sellerAta)).value.amount,
    );

    await sellerBazaar.claimTimeout(handle.escrowPda.toBase58());

    await assertEscrowState(connection, handle.escrowPda, 'timeoutClaimed');
    await assertVaultBalance(connection, handle.vaultPda, 0n);

    const sellerBalanceAfter = BigInt(
      (await connection.getTokenAccountBalance(sellerAta)).value.amount,
    );
    expect(sellerBalanceAfter - sellerBalanceBefore).toBe(BUDGET);
  });

  afterAll(async () => {
    // Devnet test state is ephemeral and harmless; no cleanup required.
  });
});
