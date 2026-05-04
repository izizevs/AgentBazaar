import type { BazaarRegistry } from '@agent-bazaar/idl';
import { BazaarRegistryIDL, computeCapabilityHash, MetadataSchema } from '@agent-bazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, type Connection, PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import type { AnchorWallet } from './client.js';
import {
  DuplicateListingError,
  MetadataUploadError,
  TransactionFailedError,
  ValidationError,
} from './errors.js';
import { clusterFromConnection, PROGRAM_IDS } from './program-ids.js';
import type { RegisterInput, RegisterResult } from './types.js';

const U64_MAX = 18_446_744_073_709_551_615n;

const PRICING_MODEL_BYTE: Record<RegisterInput['pricingModel'], number> = {
  per_request: 0,
  per_job: 1,
  hourly: 2,
  subscription: 3,
};

const PRICING_MODELS = Object.keys(PRICING_MODEL_BYTE) as Array<RegisterInput['pricingModel']>;

function toPricingModelByte(value: unknown): number {
  if (typeof value !== 'string' || !(value in PRICING_MODEL_BYTE)) {
    throw new ValidationError(
      `pricingModel must be one of ${PRICING_MODELS.join(' | ')}, got ${typeof value === 'string' ? `"${value}"` : typeof value}`,
    );
  }
  return PRICING_MODEL_BYTE[value as RegisterInput['pricingModel']];
}

// micro-lamports per compute unit for successive retry attempts
const RETRY_PRIORITY_FEES = [0, 100_000, 500_000] as const;

// ─── Pinata upload ────────────────────────────────────────────────────────────

async function uploadMetadata(
  payload: Record<string, unknown>,
  pinataJwt: string,
): Promise<string> {
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'metadata.json');
  // Pinata v3 defaults `network` to 'private' — files are then unreachable via
  // the public gateway.pinata.cloud, which the indexer needs for IPFS metadata
  // fetch. Always upload to the public network so listings are indexable.
  form.append('network', 'public');

  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: form,
  });

  if (!res.ok) {
    throw new MetadataUploadError(`Pinata upload failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data: { cid: string } };
  const cid = json.data?.cid;
  if (!cid || typeof cid !== 'string') {
    throw new MetadataUploadError('Pinata response missing data.cid');
  }

  // Store only the CID (no ipfs:// prefix) to stay within the 64-byte
  // on-chain metadata_uri field (CIDv1 ≈ 59 chars; prefix would overflow).
  if (cid.length > 64) {
    throw new MetadataUploadError(
      `CID too long for on-chain storage: ${cid.length} chars (max 64)`,
    );
  }

  return cid;
}

// ─── SLA params mapping ───────────────────────────────────────────────────────

function toAnchorSla(sla: RegisterInput['sla']): {
  maxLatencyMs: number | null;
  minUptimePct: number | null;
  responseFormat: string | null;
  jsonSchemaUri: string | null;
  customParams: Array<{ key: string; value: string }>;
} {
  return {
    maxLatencyMs: sla.maxLatencyMs ?? null,
    minUptimePct: sla.minUptimePct ?? null,
    responseFormat: sla.responseFormat ?? null,
    jsonSchemaUri: sla.jsonSchemaUri ?? null,
    customParams: sla.customParams ?? [],
  };
}

// ─── main register flow ───────────────────────────────────────────────────────

export async function registerService(
  connection: Connection,
  wallet: AnchorWallet,
  input: RegisterInput,
  pinataJwt: string,
): Promise<RegisterResult> {
  // 1. Validate all metadata fields via MetadataSchema (endpoint is schema-validated — M1)
  const parseResult = MetadataSchema.safeParse({
    name: input.name,
    description: input.description,
    capability: input.capability,
    endpoint: input.endpoint,
    avatar: input.avatar,
    custom: input.custom,
  });
  if (!parseResult.success) {
    throw new ValidationError(parseResult.error.message);
  }

  // 2. Guard u64 ranges for on-chain BN encoding (L2)
  if (input.priceUsdc < 0n || input.priceUsdc > U64_MAX) {
    throw new ValidationError(`priceUsdc out of u64 range: ${input.priceUsdc}`);
  }
  const satiId = input.satiAgentId ?? 0n;
  if (satiId < 0n || satiId > U64_MAX) {
    throw new ValidationError(`satiAgentId out of u64 range: ${satiId}`);
  }

  // 3. Compute 32-byte capability_hash
  const capHash = await computeCapabilityHash(input.capability);
  const capHashArray = Array.from(capHash) as number[];

  // 4. Derive listing PDA — use cluster-aware registry program ID
  const registryProgramId = PROGRAM_IDS[clusterFromConnection(connection)].registry;
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), wallet.publicKey.toBuffer(), Buffer.from(capHash)],
    registryProgramId,
  );

  // 5. Build Anchor Program
  // biome-ignore lint/suspicious/noExplicitAny: Anchor's Wallet interface requires a payer Keypair; our structural AnchorWallet is compatible at runtime
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  const program = new Program<BazaarRegistry>(BazaarRegistryIDL, provider);

  // 6. DuplicateListingError guard
  const existing = await program.account.serviceListing.fetchNullable(listingPda);
  if (existing?.isActive) {
    throw new DuplicateListingError(
      `Active listing already exists for capability: ${input.capability}`,
    );
  }

  // 7. Upload metadata to Pinata (endpoint is already in parseResult.data)
  const metadataUri = await uploadMetadata(parseResult.data, pinataJwt);

  // 8. Prepare instruction arguments
  const satiAgentId = new BN(satiId.toString());
  const priceUsdcBaseUnits = new BN(input.priceUsdc.toString());
  const pricingModelByte = toPricingModelByte(input.pricingModel);
  const slaParams = toAnchorSla(input.sla);

  // 9. Build instruction
  const ix = await program.methods
    .registerService(
      capHashArray,
      satiAgentId,
      priceUsdcBaseUnits,
      pricingModelByte,
      slaParams,
      metadataUri,
    )
    .accounts({ owner: wallet.publicKey })
    .instruction();

  // 10. Send with retry + priority fee escalation
  let lastError: Error | undefined;

  for (const priorityFee of RETRY_PRIORITY_FEES) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey });

      if (priorityFee > 0) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
      }
      tx.add(ix);

      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      // M2: on-chain reverts resolve confirmTransaction without throwing — check explicitly.
      if (result.value.err) {
        throw new TransactionFailedError(
          `Program error: ${JSON.stringify(result.value.err)}`,
          signature,
        );
      }

      return { listing: listingPda, signature };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new TransactionFailedError(
    lastError?.message ?? 'Transaction failed after all retry attempts',
  );
}
