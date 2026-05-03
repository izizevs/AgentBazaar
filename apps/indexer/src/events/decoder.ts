import { Buffer } from 'node:buffer';
import { bazaarRegistryIdl } from '@agentbazaar/idl';
import type { Idl } from '@coral-xyz/anchor';
import { BorshEventCoder } from '@coral-xyz/anchor';
import bs58 from 'bs58';

const eventCoder = new BorshEventCoder(bazaarRegistryIdl as unknown as Idl);

// Helius enhanced webhook delivers inner-instruction `data` as a base58 string.
// For Anchor `emit_cpi!`-emitted events, the bytes are:
//   [0..8]   __EVENT_IX_TAG (constant, identifies a self-CPI event emission)
//   [8..16]  event discriminator
//   [16..]   borsh-serialized event data
// BorshEventCoder.decode() expects a base64 string starting at the event
// discriminator (bytes[8:]), so we strip the IX tag prefix first.
function toEventBase64(data: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(data);
  } catch {
    return null;
  }
  if (bytes.length < 16) return null;
  return Buffer.from(bytes.slice(8)).toString('base64');
}

export type RegistryEvent =
  | { name: 'ServiceListingCreated'; data: ServiceListingCreatedData }
  | { name: 'ServiceListingUpdated'; data: ServiceListingUpdatedData };

// Raw decoded shapes from BorshEventCoder — Anchor maps:
//   pubkey  → PublicKey (.toString() gives base58)
//   u64/i64 → BN       (.toString() gives decimal string)
//   [u8;32] → number[]
export type ServiceListingCreatedData = {
  listing: { toString(): string };
  owner: { toString(): string };
  satiAgentId: { toString(): string };
  capabilityHash: number[];
  priceUsdcBaseUnits: { toString(): string };
  pricingModel: number;
  metadataUri: string;
  createdAt: { toString(): string };
};

export type ServiceListingUpdatedData = {
  listing: { toString(): string };
  owner: { toString(): string };
  newPrice: { toString(): string } | null;
  newUri: string | null;
  isActive: boolean;
  updatedAt: { toString(): string };
};

// BorshEventCoder returns data with snake_case field names matching the IDL;
// our handlers expect camelCase. Walk the object and convert.
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function normalizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[snakeToCamel(k)] = normalizeKeys(v);
    }
    return out;
  }
  return obj;
}

export function decodeRegistryEvent(data: string): RegistryEvent | null {
  try {
    const eventB64 = toEventBase64(data);
    if (!eventB64) return null;
    const decoded = eventCoder.decode(eventB64);
    if (!decoded) return null;
    if (decoded.name === 'ServiceListingCreated' || decoded.name === 'ServiceListingUpdated') {
      return { name: decoded.name, data: normalizeKeys(decoded.data) } as RegistryEvent;
    }
    return null;
  } catch {
    return null;
  }
}
