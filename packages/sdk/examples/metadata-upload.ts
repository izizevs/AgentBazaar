/**
 * metadata-upload.ts — compute a capability hash and upload service metadata to IPFS via Pinata.
 *
 * This is the same flow used internally by client.register(), exposed here for
 * agents that want to pre-upload metadata or inspect the hash before registering.
 *
 * Prerequisites:
 *   PINATA_JWT env var set
 *
 * Run:
 *   PINATA_JWT=your_jwt npx tsx examples/metadata-upload.ts
 */

import { computeCapabilityHash } from '@agentbazaar/idl';
import { MetadataUploadError } from '@agentbazaar/sdk';

const PINATA_JWT = process.env.PINATA_JWT ?? '';
if (!PINATA_JWT) {
  console.error('PINATA_JWT env var is required');
  process.exit(1);
}

// ── Step 1: compute the on-chain capability hash ──────────────────────────────

const capability = 'data-analysis-v1';
const capabilityHash = computeCapabilityHash(capability);
console.log('Capability:', capability);
console.log('SHA-256 hash (hex):', Buffer.from(capabilityHash).toString('hex'));

// ── Step 2: build the metadata payload ───────────────────────────────────────

const metadata = {
  name: 'My Data Analysis Agent',
  description: 'Accepts CSV payloads and returns statistical summaries via JSON.',
  capability,
  endpoint: 'https://my-agent.example.com/api',
  avatar: 'https://my-agent.example.com/avatar.png',
  pricingModel: 'per_request',
  priceUsdc: '1000000', // 1 USDC — stored as string to preserve BigInt precision
  sla: {
    maxLatencyMs: 5000,
    minUptimePct: 9500,
    responseFormat: 'json',
  },
  custom: {
    modelFamily: 'gpt-4o',
    region: 'us-east-1',
  },
};

// ── Step 3: upload to Pinata ──────────────────────────────────────────────────

const blob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
const form = new FormData();
form.append('file', blob, 'metadata.json');

let cid: string;
try {
  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });

  if (!res.ok) {
    throw new MetadataUploadError(`Pinata upload failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data: { cid: string } };
  cid = json.data.cid;
} catch (err) {
  if (err instanceof MetadataUploadError) {
    console.error(err.message);
  } else {
    console.error('Unexpected error during upload:', err);
  }
  process.exit(1);
}

const metadataUri = `ipfs://${cid}`;
console.log('\nMetadata uploaded successfully.');
console.log('CID:         ', cid);
console.log('Metadata URI:', metadataUri);
console.log('\nPass this URI to client.register() via the AgentBazaar SDK,');
console.log('or use it directly in the bazaar_registry on-chain program.');
