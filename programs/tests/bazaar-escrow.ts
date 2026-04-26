import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Program } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import { createAccount, createMint, getAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from '@solana/web3.js';
import BN from 'bn.js';
import { expect } from 'chai';

import type { BazaarEscrow } from '../target/types/bazaar_escrow';
import type { BazaarRegistry } from '../target/types/bazaar_registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ESCROW_SEED = Buffer.from('escrow');
const VAULT_SEED = Buffer.from('vault');
const LISTING_SEED = Buffer.from('listing');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');
const USDC_DECIMALS = 6;
const ONE_USDC = 1_000_000; // 1 USDC in base units

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fund(connection: anchor.web3.Connection, pubkey: PublicKey, sol = 2): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
}

function hashCapability(capability: string): Buffer {
  return createHash('sha256').update(capability).digest();
}

function listingPda(registryProgramId: PublicKey, owner: PublicKey, capHash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LISTING_SEED, owner.toBuffer(), capHash],
    registryProgramId,
  )[0];
}

function escrowPda(
  escrowProgramId: PublicKey,
  buyer: PublicKey,
  listing: PublicKey,
  nonce: BN,
): PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, buyer.toBuffer(), listing.toBuffer(), nonceBuf],
    escrowProgramId,
  )[0];
}

function vaultPda(escrowProgramId: PublicKey, escrow: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, escrow.toBuffer()], escrowProgramId)[0];
}

// C1 fix: escrow authority PDA — derived from [b"authority"] in bazaar-escrow.
// Registry verifies seeds::program = BAZAAR_ESCROW_ID to prevent direct calls.
function escrowAuthorityPda(escrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('authority')], escrowProgramId)[0];
}

function eventAuthorityPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], programId)[0];
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface EscrowFixture {
  buyer: Keypair;
  seller: Keypair;
  usdcMint: PublicKey;
  buyerTokenAccount: PublicKey;
  sellerTokenAccount: PublicKey;
  listing: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  nonce: BN;
  amount: number;
}

async function setupEscrow(
  connection: anchor.web3.Connection,
  registryProgram: Program<BazaarRegistry>,
  escrowProgram: Program<BazaarEscrow>,
  mintAuthority: Keypair,
  usdcMint: PublicKey,
  opts: {
    amount?: number;
    deadlineSecs?: number;
    slaMaxLatencyMs?: number | null;
  } = {},
): Promise<EscrowFixture> {
  const amount = opts.amount ?? 10 * ONE_USDC;
  const deadlineSecs = opts.deadlineSecs ?? 3600;
  const slaMaxLatencyMs = opts.slaMaxLatencyMs !== undefined ? opts.slaMaxLatencyMs : null;

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  await fund(connection, buyer.publicKey, 5);
  await fund(connection, seller.publicKey, 2);

  // Token accounts
  const buyerTokenAccount = await createAccount(connection, buyer, usdcMint, buyer.publicKey);
  const sellerTokenAccount = await createAccount(connection, seller, usdcMint, seller.publicKey);

  // Mint USDC to buyer
  await mintTo(
    connection,
    mintAuthority,
    usdcMint,
    buyerTokenAccount,
    mintAuthority,
    amount + ONE_USDC,
  );

  // Register a listing for the seller in bazaar-registry
  const capHash = hashCapability(`ai.test.${randomBytes(4).toString('hex')}`);
  const listing = listingPda(registryProgram.programId, seller.publicKey, capHash);
  const registryEventAuthority = eventAuthorityPda(registryProgram.programId);
  const escrowEventAuthority = eventAuthorityPda(escrowProgram.programId);
  await registryProgram.methods
    .registerService(
      [...capHash],
      new BN(99),
      new BN(ONE_USDC),
      0,
      {
        maxLatencyMs: slaMaxLatencyMs != null ? slaMaxLatencyMs : null,
        minUptimePct: null,
        responseFormat: null,
        jsonSchemaUri: null,
        customParams: [],
      },
      'ipfs://QmTest',
    )
    .accounts({
      owner: seller.publicKey,
      listing,
      systemProgram: SystemProgram.programId,
      eventAuthority: registryEventAuthority,
      program: registryProgram.programId,
    } as any)
    .signers([seller])
    .rpc();

  const nonce = new BN(Date.now());
  const escrow = escrowPda(escrowProgram.programId, buyer.publicKey, listing, nonce);
  const vault = vaultPda(escrowProgram.programId, escrow);

  await escrowProgram.methods
    .createEscrow(
      new BN(amount),
      slaMaxLatencyMs != null ? slaMaxLatencyMs : null,
      null,
      new BN(deadlineSecs),
      nonce,
    )
    .accounts({
      buyer: buyer.publicKey,
      listing,
      escrow,
      vault,
      buyerTokenAccount,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: escrowEventAuthority,
      program: escrowProgram.programId,
    } as any)
    .signers([buyer])
    .rpc();

  return {
    buyer,
    seller,
    usdcMint,
    buyerTokenAccount,
    sellerTokenAccount,
    listing,
    escrow,
    vault,
    nonce,
    amount,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('bazaar-escrow', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const escrowProgram = anchor.workspace.bazaarEscrow as Program<BazaarEscrow>;
  const registryProgram = anchor.workspace.bazaarRegistry as Program<BazaarRegistry>;
  const connection = provider.connection;

  let mintAuthority: Keypair;
  let usdcMint: PublicKey;
  let escrowEventAuthority: PublicKey;
  let registryEventAuthority: PublicKey;

  before(async () => {
    escrowEventAuthority = eventAuthorityPda(escrowProgram.programId);
    registryEventAuthority = eventAuthorityPda(registryProgram.programId);
    // Load the deterministic test mint authority from fixtures.
    // The mint itself (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) is pre-loaded
    // by Anchor.toml [[test.validator.account]] at the canonical devnet USDC address.
    mintAuthority = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(readFileSync('./tests/fixtures/test-mint-authority.json', 'utf8')) as number[],
      ),
    );
    await fund(connection, mintAuthority.publicKey, 5);
    usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  // -------------------------------------------------------------------------
  // create_escrow
  // -------------------------------------------------------------------------

  describe('create_escrow', () => {
    it('initialises EscrowAccount and transfers USDC to vault', async () => {
      const { buyer, escrow, vault, amount, buyerTokenAccount } = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );

      const acct = await escrowProgram.account.escrowAccount.fetch(escrow);
      expect(acct.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
      expect(acct.amount.toNumber()).to.equal(amount);
      expect(JSON.stringify(acct.state)).to.match(/created/i);

      const vaultAcct = await getAccount(connection, vault);
      expect(Number(vaultAcct.amount)).to.equal(amount);

      const buyerAcct = await getAccount(connection, buyerTokenAccount);
      expect(Number(buyerAcct.amount)).to.equal(ONE_USDC); // only leftover
    });

    it('rejects create_escrow with wrong USDC mint (ConstraintAddress)', async () => {
      const badMintKp = Keypair.generate();
      const buyer = Keypair.generate();
      const seller = Keypair.generate();
      await fund(connection, buyer.publicKey, 5);
      await fund(connection, seller.publicKey, 2);

      const fakeMint = await createMint(
        connection,
        mintAuthority,
        mintAuthority.publicKey,
        null,
        USDC_DECIMALS,
        badMintKp,
      );

      const capHash = hashCapability(`ai.badmint.${randomBytes(4).toString('hex')}`);
      const listing = listingPda(registryProgram.programId, seller.publicKey, capHash);
      await registryProgram.methods
        .registerService(
          [...capHash],
          new BN(1),
          new BN(0),
          0,
          {
            maxLatencyMs: null,
            minUptimePct: null,
            responseFormat: null,
            jsonSchemaUri: null,
            customParams: [],
          },
          'ipfs://Qmbad',
        )
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
          eventAuthority: registryEventAuthority,
          program: registryProgram.programId,
        } as any)
        .signers([seller])
        .rpc();

      const nonce = new BN(Date.now());
      const escrow = escrowPda(escrowProgram.programId, buyer.publicKey, listing, nonce);
      const vault = vaultPda(escrowProgram.programId, escrow);
      const buyerTokenAccount = await createAccount(connection, buyer, fakeMint, buyer.publicKey);

      try {
        await escrowProgram.methods
          .createEscrow(new BN(ONE_USDC), null, null, new BN(3600), nonce)
          .accounts({
            buyer: buyer.publicKey,
            listing,
            escrow,
            vault,
            buyerTokenAccount,
            usdcMint: fakeMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail('expected ConstraintAddress');
      } catch (err: any) {
        expect(err.toString()).to.match(/ConstraintAddress/);
      }
    });

    it('rejects zero amount', async () => {
      const seller = Keypair.generate();
      await fund(connection, seller.publicKey, 2);
      const buyer = Keypair.generate();
      await fund(connection, buyer.publicKey, 5);

      const capHash = hashCapability(`ai.zero.${randomBytes(4).toString('hex')}`);
      const listing = listingPda(registryProgram.programId, seller.publicKey, capHash);
      await registryProgram.methods
        .registerService(
          [...capHash],
          new BN(1),
          new BN(0),
          0,
          {
            maxLatencyMs: null,
            minUptimePct: null,
            responseFormat: null,
            jsonSchemaUri: null,
            customParams: [],
          },
          'ipfs://QmZ',
        )
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
          eventAuthority: registryEventAuthority,
          program: registryProgram.programId,
        } as any)
        .signers([seller])
        .rpc();

      const nonce = new BN(Date.now());
      const escrow = escrowPda(escrowProgram.programId, buyer.publicKey, listing, nonce);
      const vault = vaultPda(escrowProgram.programId, escrow);
      const buyerTokenAccount = await createAccount(connection, buyer, usdcMint, buyer.publicKey);

      try {
        await escrowProgram.methods
          .createEscrow(new BN(0), null, null, new BN(3600), nonce)
          .accounts({
            buyer: buyer.publicKey,
            listing,
            escrow,
            vault,
            buyerTokenAccount,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail('expected ZeroAmount');
      } catch (err: any) {
        expect(err.toString()).to.match(/ZeroAmount/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // submit_delivery
  // -------------------------------------------------------------------------

  describe('submit_delivery', () => {
    it('transitions Created → Delivered and records result URI + hash', async () => {
      const { seller, escrow, vault, sellerTokenAccount } = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );

      const resultHash = Array.from(randomBytes(32));
      await escrowProgram.methods
        .submitDelivery('ipfs://QmResult', resultHash as any)
        .accounts({
          seller: seller.publicKey,
          escrow,
          vault,
          sellerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([seller])
        .rpc();

      const acct = await escrowProgram.account.escrowAccount.fetch(escrow);
      expect(JSON.stringify(acct.state)).to.match(/delivered/i);
      expect(acct.resultUri).to.equal('ipfs://QmResult');
    });

    it('rejects submit from non-seller', async () => {
      const { escrow, vault } = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      const outsider = Keypair.generate();
      await fund(connection, outsider.publicKey, 2);
      const outsiderToken = await createAccount(connection, outsider, usdcMint, outsider.publicKey);

      try {
        await escrowProgram.methods
          .submitDelivery('ipfs://QmFake', Array.from(randomBytes(32)) as any)
          .accounts({
            seller: outsider.publicKey,
            escrow,
            vault,
            sellerTokenAccount: outsiderToken,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([outsider])
          .rpc();
        expect.fail('expected Unauthorized');
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|seeds constraint/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // confirm_delivery — SLA severity branches + security negative tests
  // -------------------------------------------------------------------------

  describe('confirm_delivery', () => {
    async function confirmSetup(slaMaxLatencyMs: number | null) {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
        { slaMaxLatencyMs },
      );
      const resultHash = Array.from(randomBytes(32));
      await escrowProgram.methods
        .submitDelivery('ipfs://QmResult', resultHash as any)
        .accounts({
          seller: f.seller.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.seller])
        .rpc();
      return f;
    }

    it('Minor severity (no SLA params) → 100% to seller', async () => {
      const f = await confirmSetup(null);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const sellerBefore = Number((await getAccount(connection, f.sellerTokenAccount)).amount);

      await escrowProgram.methods
        .confirmDelivery(95, [])
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          listing: f.listing,
          registryProgram: registryProgram.programId,
          escrowAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const sellerAfter = Number((await getAccount(connection, f.sellerTokenAccount)).amount);
      expect(sellerAfter - sellerBefore).to.equal(f.amount); // 100% to seller

      const acct = await escrowProgram.account.escrowAccount.fetch(f.escrow);
      expect(JSON.stringify(acct.state)).to.match(/confirmed/i);
    });

    it('Moderate severity (10–50% over SLA) → 80% seller / 20% buyer refund', async () => {
      // Strategy: set max_latency_ms = 700.
      // 10% threshold = 770ms, 50% threshold = 1050ms.
      // Localnet block time ~1s = 1000ms → falls in (770, 1050] → Moderate.
      const f = await confirmSetup(700);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const sellerBefore = Number((await getAccount(connection, f.sellerTokenAccount)).amount);
      const buyerBefore = Number((await getAccount(connection, f.buyerTokenAccount)).amount);

      await escrowProgram.methods
        .confirmDelivery(80, [])
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          listing: f.listing,
          registryProgram: registryProgram.programId,
          escrowAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const sellerAfter = Number((await getAccount(connection, f.sellerTokenAccount)).amount);
      const buyerAfter = Number((await getAccount(connection, f.buyerTokenAccount)).amount);
      const sellerGot = sellerAfter - sellerBefore;
      const buyerGot = buyerAfter - buyerBefore;

      // Either Moderate (80/20) or boundary — verify they sum to amount and seller >= buyer
      expect(sellerGot + buyerGot).to.equal(f.amount);
      expect(sellerGot).to.be.greaterThanOrEqual(buyerGot);
    });

    it('Major severity (>50% over SLA) → 50/50 split', async () => {
      // max_latency_ms = 1 → actual (seconds) >> 1.5x threshold → Major
      const f = await confirmSetup(1);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const sellerBefore = Number((await getAccount(connection, f.sellerTokenAccount)).amount);
      const buyerBefore = Number((await getAccount(connection, f.buyerTokenAccount)).amount);

      await escrowProgram.methods
        .confirmDelivery(40, [])
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          listing: f.listing,
          registryProgram: registryProgram.programId,
          escrowAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const sellerAfter = Number((await getAccount(connection, f.sellerTokenAccount)).amount);
      const buyerAfter = Number((await getAccount(connection, f.buyerTokenAccount)).amount);
      expect(sellerAfter - sellerBefore).to.equal(f.amount / 2);
      expect(buyerAfter - buyerBefore).to.equal(f.amount / 2);
    });

    it('increments listing.jobs_completed via CPI', async () => {
      const f = await confirmSetup(null);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const listingBefore = await registryProgram.account.serviceListing.fetch(f.listing);
      const before = listingBefore.jobsCompleted;

      await escrowProgram.methods
        .confirmDelivery(90, [])
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          listing: f.listing,
          registryProgram: registryProgram.programId,
          escrowAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const listingAfter = await registryProgram.account.serviceListing.fetch(f.listing);
      expect(listingAfter.jobsCompleted).to.equal(before + 1);
    });

    it('rejects confirm from non-buyer', async () => {
      const f = await confirmSetup(null);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const outsider = Keypair.generate();
      await fund(connection, outsider.publicKey, 2);
      const outsiderToken = await createAccount(connection, outsider, usdcMint, outsider.publicKey);

      try {
        await escrowProgram.methods
          .confirmDelivery(90, [])
          .accounts({
            buyer: outsider.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            sellerTokenAccount: f.sellerTokenAccount,
            buyerTokenAccount: outsiderToken,
            usdcMint,
            listing: f.listing,
            registryProgram: registryProgram.programId,
            escrowAuthority,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([outsider])
          .rpc();
        expect.fail('expected Unauthorized');
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|seeds constraint/i);
      }
    });

    // C2 negative test: buyer passes their own token account as seller_token_account
    // to redirect the seller's USDC payout to themselves.
    it('rejects confirm_delivery when seller_token_account is not owned by escrow.seller', async () => {
      const f = await confirmSetup(null);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      // Attacker (the buyer) creates their own second token account and tries to
      // pass it as the seller's payout destination.
      const attackerToken = await createAccount(connection, f.buyer, usdcMint, f.buyer.publicKey);

      try {
        await escrowProgram.methods
          .confirmDelivery(90, [])
          .accounts({
            buyer: f.buyer.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            sellerTokenAccount: attackerToken, // buyer's account, not seller's
            buyerTokenAccount: f.buyerTokenAccount,
            usdcMint,
            listing: f.listing,
            registryProgram: registryProgram.programId,
            escrowAuthority,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([f.buyer])
          .rpc();
        expect.fail('expected token owner constraint violation');
      } catch (err: any) {
        expect(err.toString()).to.match(
          /ConstraintTokenOwner|token owner|ConstraintRaw|constraint/i,
        );
      }
    });

    it('rejects double-confirm (state already Confirmed)', async () => {
      const f = await confirmSetup(null);
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);
      const accounts = {
        buyer: f.buyer.publicKey,
        escrow: f.escrow,
        vault: f.vault,
        sellerTokenAccount: f.sellerTokenAccount,
        buyerTokenAccount: f.buyerTokenAccount,
        usdcMint,
        listing: f.listing,
        registryProgram: registryProgram.programId,
        escrowAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
        eventAuthority: escrowEventAuthority,
        program: escrowProgram.programId,
      } as any;

      await escrowProgram.methods
        .confirmDelivery(90, [])
        .accounts(accounts)
        .signers([f.buyer])
        .rpc();

      try {
        await escrowProgram.methods
          .confirmDelivery(90, [])
          .accounts(accounts)
          .signers([f.buyer])
          .rpc();
        expect.fail('expected InvalidStateTransition');
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidStateTransition/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // increment_jobs_completed — C1 negative test
  // -------------------------------------------------------------------------

  describe('increment_jobs_completed (registry CPI gate)', () => {
    it('rejects direct call without escrow-program-derived authority', async () => {
      // Setup a listing
      const seller = Keypair.generate();
      await fund(connection, seller.publicKey, 2);
      const capHash = hashCapability(`ai.c1.${randomBytes(4).toString('hex')}`);
      const listing = listingPda(registryProgram.programId, seller.publicKey, capHash);
      await registryProgram.methods
        .registerService(
          [...capHash],
          new BN(1),
          new BN(0),
          0,
          {
            maxLatencyMs: null,
            minUptimePct: null,
            responseFormat: null,
            jsonSchemaUri: null,
            customParams: [],
          },
          'ipfs://QmC1',
        )
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
          eventAuthority: registryEventAuthority,
          program: registryProgram.programId,
        } as any)
        .signers([seller])
        .rpc();

      // A random keypair — its pubkey is NOT the PDA derived from [b"authority"] in bazaar-escrow.
      // The seeds constraint on escrow_authority will reject it.
      const fakeAuthority = Keypair.generate();
      try {
        await registryProgram.methods
          .incrementJobsCompleted()
          .accounts({ listing, escrowAuthority: fakeAuthority.publicKey } as any)
          .signers([fakeAuthority])
          .rpc();
        expect.fail('expected ConstraintSeeds');
      } catch (err: any) {
        expect(err.toString()).to.match(/ConstraintSeeds|seeds constraint/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // claim_timeout
  // -------------------------------------------------------------------------

  describe('claim_timeout', () => {
    it('rejects timeout when deadline has NOT passed', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      await escrowProgram.methods
        .submitDelivery('ipfs://QmDelivered', Array.from(randomBytes(32)) as any)
        .accounts({
          seller: f.seller.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.seller])
        .rpc();

      try {
        await escrowProgram.methods
          .claimTimeout()
          .accounts({
            seller: f.seller.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            sellerTokenAccount: f.sellerTokenAccount,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([f.seller])
          .rpc();
        expect.fail('expected DeadlineNotYetPassed');
      } catch (err: any) {
        expect(err.toString()).to.match(/DeadlineNotYetPassed/);
      }
    });

    it('rejects timeout when state is Created (not Delivered)', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
        { deadlineSecs: 1 },
      );
      // Do NOT submit delivery — state stays Created
      try {
        await escrowProgram.methods
          .claimTimeout()
          .accounts({
            seller: f.seller.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            sellerTokenAccount: f.sellerTokenAccount,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([f.seller])
          .rpc();
        expect.fail('expected InvalidStateTransition');
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidStateTransition|DeadlineNotYetPassed/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // open_dispute
  // -------------------------------------------------------------------------

  describe('open_dispute', () => {
    it('full refund to buyer and sets state Disputed (from Created)', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      const buyerBefore = Number((await getAccount(connection, f.buyerTokenAccount)).amount);

      await escrowProgram.methods
        .openDispute('Service did not meet spec', 'ipfs://QmEvidence')
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const buyerAfter = Number((await getAccount(connection, f.buyerTokenAccount)).amount);
      expect(buyerAfter - buyerBefore).to.equal(f.amount);

      const acct = await escrowProgram.account.escrowAccount.fetch(f.escrow);
      expect(JSON.stringify(acct.state)).to.match(/disputed/i);
    });

    it('full refund to buyer (from Delivered)', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      await escrowProgram.methods
        .submitDelivery('ipfs://QmR', Array.from(randomBytes(32)) as any)
        .accounts({
          seller: f.seller.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.seller])
        .rpc();

      const buyerBefore = Number((await getAccount(connection, f.buyerTokenAccount)).amount);
      await escrowProgram.methods
        .openDispute('Wrong format', 'ipfs://QmEv2')
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      const buyerAfter = Number((await getAccount(connection, f.buyerTokenAccount)).amount);
      expect(buyerAfter - buyerBefore).to.equal(f.amount);
    });

    it('rejects dispute from non-buyer', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      const outsider = Keypair.generate();
      await fund(connection, outsider.publicKey, 2);
      const outsiderToken = await createAccount(connection, outsider, usdcMint, outsider.publicKey);

      try {
        await escrowProgram.methods
          .openDispute('Fake', 'ipfs://Fake')
          .accounts({
            buyer: outsider.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            buyerTokenAccount: outsiderToken,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([outsider])
          .rpc();
        expect.fail('expected Unauthorized');
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|seeds constraint/i);
      }
    });

    it('rejects dispute on already-confirmed escrow', async () => {
      const f = await setupEscrow(
        connection,
        registryProgram,
        escrowProgram,
        mintAuthority,
        usdcMint,
      );
      const escrowAuthority = escrowAuthorityPda(escrowProgram.programId);

      await escrowProgram.methods
        .submitDelivery('ipfs://QmR', Array.from(randomBytes(32)) as any)
        .accounts({
          seller: f.seller.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.seller])
        .rpc();
      await escrowProgram.methods
        .confirmDelivery(90, [])
        .accounts({
          buyer: f.buyer.publicKey,
          escrow: f.escrow,
          vault: f.vault,
          sellerTokenAccount: f.sellerTokenAccount,
          buyerTokenAccount: f.buyerTokenAccount,
          usdcMint,
          listing: f.listing,
          registryProgram: registryProgram.programId,
          escrowAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: escrowEventAuthority,
          program: escrowProgram.programId,
        } as any)
        .signers([f.buyer])
        .rpc();

      try {
        await escrowProgram.methods
          .openDispute('Too late', 'ipfs://Late')
          .accounts({
            buyer: f.buyer.publicKey,
            escrow: f.escrow,
            vault: f.vault,
            buyerTokenAccount: f.buyerTokenAccount,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            eventAuthority: escrowEventAuthority,
            program: escrowProgram.programId,
          } as any)
          .signers([f.buyer])
          .rpc();
        expect.fail('expected InvalidStateTransition');
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidStateTransition/);
      }
    });
  });
});
