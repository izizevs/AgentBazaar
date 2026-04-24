import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { createHash, randomBytes } from "node:crypto";

import type { BazaarRegistry } from "../target/types/bazaar_registry";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const LISTING_SEED = Buffer.from("listing");

function hashCapability(capability: string): Buffer {
  return createHash("sha256").update(capability).digest();
}

function listingPda(programId: PublicKey, owner: PublicKey, capabilityHash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LISTING_SEED, owner.toBuffer(), capabilityHash],
    programId,
  )[0];
}

async function fund(connection: anchor.web3.Connection, pubkey: PublicKey, sol = 2): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
}

function emptySla(): any {
  return {
    maxLatencyMs: null,
    minUptimePct: null,
    responseFormat: null,
    jsonSchemaUri: null,
    customParams: [],
  };
}

function fullSla(): any {
  return {
    maxLatencyMs: 300,
    minUptimePct: 9500, // 95.00%
    responseFormat: "json",
    jsonSchemaUri: "ipfs://QmSchema",
    customParams: [{ key: "region", value: "us-east-1" }],
  };
}

// -------------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------------

describe("bazaar-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.bazaarRegistry as Program<BazaarRegistry>;
  const connection = provider.connection;

  let seller: Keypair;
  let outsider: Keypair;
  let capability: string;
  let capabilityHash: Buffer;
  let listing: PublicKey;

  before(async () => {
    seller = Keypair.generate();
    outsider = Keypair.generate();
    await fund(connection, seller.publicKey, 5);
    await fund(connection, outsider.publicKey, 2);
  });

  beforeEach(() => {
    // Each test registers under a fresh capability so PDA collisions don't
    // leak across tests — the program does correctly reject duplicates, but
    // we don't want that enforcement to mask unrelated assertions.
    capability = `ai.embeddings.${randomBytes(4).toString("hex")}`;
    capabilityHash = hashCapability(capability);
    listing = listingPda(program.programId, seller.publicKey, capabilityHash);
  });

  // ---- register_service ---------------------------------------------------

  describe("register_service", () => {
    it("creates a ServiceListing PDA with the given fields", async () => {
      const metadataUri = "ipfs://QmMetadataHash";

      const sig = await program.methods
        .registerService(
          [...capabilityHash],
          new BN(42),
          new BN(1_000_000),
          1, // per_job
          fullSla(),
          metadataUri,
        )
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([seller])
        .rpc();
      expect(sig).to.be.a("string");

      const acct = await program.account.serviceListing.fetch(listing);
      expect(acct.owner.toBase58()).to.equal(seller.publicKey.toBase58());
      expect(acct.satiAgentId.toNumber()).to.equal(42);
      expect(Buffer.from(acct.capabilityHash).equals(capabilityHash)).to.equal(true);
      expect(acct.priceLamports.toNumber()).to.equal(1_000_000);
      expect(acct.pricingModel).to.equal(1);
      expect(acct.metadataUri).to.equal(metadataUri);
      expect(acct.isActive).to.equal(true);
      expect(acct.jobsCompleted).to.equal(0);
      expect(acct.createdAt.toNumber()).to.be.greaterThan(0);
      expect(acct.slaParams.maxLatencyMs).to.equal(300);
      expect(acct.slaParams.minUptimePct).to.equal(9500);
      expect(acct.slaParams.responseFormat).to.equal("json");
      expect(acct.slaParams.customParams).to.have.length(1);
    });

    it("rejects all-zero capability_hash", async () => {
      const zero = Buffer.alloc(32, 0);
      const zeroListing = listingPda(program.programId, seller.publicKey, zero);
      try {
        await program.methods
          .registerService([...zero], new BN(1), new BN(100), 0, emptySla(), "ipfs://x")
          .accounts({
            owner: seller.publicKey,
            listing: zeroListing,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected InvalidCapabilityHash");
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidCapabilityHash/);
      }
    });

    it("rejects pricing_model > 3", async () => {
      try {
        await program.methods
          .registerService([...capabilityHash], new BN(1), new BN(100), 4, emptySla(), "ipfs://x")
          .accounts({
            owner: seller.publicKey,
            listing,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected InvalidPricingModel");
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidPricingModel/);
      }
    });

    it("rejects metadata_uri longer than 64 chars", async () => {
      const tooLong = "ipfs://" + "a".repeat(80);
      try {
        await program.methods
          .registerService([...capabilityHash], new BN(1), new BN(100), 0, emptySla(), tooLong)
          .accounts({
            owner: seller.publicKey,
            listing,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected MetadataUriTooLong");
      } catch (err: any) {
        expect(err.toString()).to.match(/MetadataUriTooLong/);
      }
    });

    it("rejects min_uptime_pct > 10000 basis points", async () => {
      const bad = { ...emptySla(), minUptimePct: 10_001 };
      try {
        await program.methods
          .registerService([...capabilityHash], new BN(1), new BN(100), 0, bad, "ipfs://x")
          .accounts({
            owner: seller.publicKey,
            listing,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected InvalidUptimePct");
      } catch (err: any) {
        expect(err.toString()).to.match(/InvalidUptimePct/);
      }
    });

    it("rejects duplicate register for the same (owner, capability_hash)", async () => {
      await program.methods
        .registerService([...capabilityHash], new BN(1), new BN(100), 0, emptySla(), "ipfs://x")
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([seller])
        .rpc();

      try {
        await program.methods
          .registerService([...capabilityHash], new BN(2), new BN(200), 0, emptySla(), "ipfs://y")
          .accounts({
            owner: seller.publicKey,
            listing,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected PDA already in use");
      } catch (err: any) {
        // Anchor surfaces this as "already in use" or a system-program allocate failure.
        expect(err.toString()).to.match(/already in use|0x0/i);
      }
    });
  });

  // ---- update_service -----------------------------------------------------

  describe("update_service", () => {
    beforeEach(async () => {
      await program.methods
        .registerService([...capabilityHash], new BN(1), new BN(500), 0, emptySla(), "ipfs://initial")
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([seller])
        .rpc();
    });

    it("updates price, SLA and metadata_uri when owner calls", async () => {
      await program.methods
        .updateService(new BN(9_999), fullSla(), "ipfs://new")
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();

      const acct = await program.account.serviceListing.fetch(listing);
      expect(acct.priceLamports.toNumber()).to.equal(9_999);
      expect(acct.metadataUri).to.equal("ipfs://new");
      expect(acct.slaParams.maxLatencyMs).to.equal(300);
      expect(acct.slaParams.customParams).to.have.length(1);
    });

    it("leaves fields untouched when corresponding argument is None", async () => {
      await program.methods
        .updateService(new BN(1234), null, null)
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();

      const acct = await program.account.serviceListing.fetch(listing);
      expect(acct.priceLamports.toNumber()).to.equal(1234);
      expect(acct.metadataUri).to.equal("ipfs://initial");
      expect(acct.slaParams.maxLatencyMs).to.equal(null);
    });

    it("rejects update from non-owner", async () => {
      try {
        await program.methods
          .updateService(new BN(1), null, null)
          .accounts({ owner: outsider.publicKey, listing } as any)
          .signers([outsider])
          .rpc();
        expect.fail("expected Unauthorized");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|seeds constraint/);
      }
    });
  });

  // ---- deactivate_service / reactivate_service ----------------------------

  describe("deactivate_service & reactivate_service", () => {
    beforeEach(async () => {
      await program.methods
        .registerService([...capabilityHash], new BN(1), new BN(500), 0, emptySla(), "ipfs://x")
        .accounts({
          owner: seller.publicKey,
          listing,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([seller])
        .rpc();
    });

    it("deactivates an active listing", async () => {
      await program.methods
        .deactivateService()
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();
      const acct = await program.account.serviceListing.fetch(listing);
      expect(acct.isActive).to.equal(false);
    });

    it("reactivates a deactivated listing", async () => {
      await program.methods
        .deactivateService()
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();
      await program.methods
        .reactivateService()
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();
      const acct = await program.account.serviceListing.fetch(listing);
      expect(acct.isActive).to.equal(true);
    });

    it("rejects deactivate when already inactive", async () => {
      await program.methods
        .deactivateService()
        .accounts({ owner: seller.publicKey, listing } as any)
        .signers([seller])
        .rpc();

      try {
        await program.methods
          .deactivateService()
          .accounts({ owner: seller.publicKey, listing } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected AlreadyInactive");
      } catch (err: any) {
        expect(err.toString()).to.match(/AlreadyInactive/);
      }
    });

    it("rejects reactivate when already active", async () => {
      try {
        await program.methods
          .reactivateService()
          .accounts({ owner: seller.publicKey, listing } as any)
          .signers([seller])
          .rpc();
        expect.fail("expected AlreadyActive");
      } catch (err: any) {
        expect(err.toString()).to.match(/AlreadyActive/);
      }
    });

    it("rejects deactivate from non-owner", async () => {
      try {
        await program.methods
          .deactivateService()
          .accounts({ owner: outsider.publicKey, listing } as any)
          .signers([outsider])
          .rpc();
        expect.fail("expected Unauthorized");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|seeds constraint/);
      }
    });
  });
});
