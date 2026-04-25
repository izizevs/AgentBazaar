import { bazaarRegistryIdl } from '@agentbazaar/idl';
import type { Idl } from '@coral-xyz/anchor';
import { BorshEventCoder } from '@coral-xyz/anchor';

const eventCoder = new BorshEventCoder(bazaarRegistryIdl as unknown as Idl);

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
  priceLamports: { toString(): string };
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

export function decodeRegistryEvent(base64Data: string): RegistryEvent | null {
  try {
    const decoded = eventCoder.decode(base64Data);
    if (!decoded) return null;
    if (decoded.name === 'ServiceListingCreated' || decoded.name === 'ServiceListingUpdated') {
      return decoded as unknown as RegistryEvent;
    }
    return null;
  } catch {
    return null;
  }
}
