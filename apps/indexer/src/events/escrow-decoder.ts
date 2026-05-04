import { Buffer } from 'node:buffer';
import { bazaarEscrowIdl } from '@agent-bazaar/idl';
import type { Idl } from '@coral-xyz/anchor';
import { BorshEventCoder } from '@coral-xyz/anchor';
import bs58 from 'bs58';

import type { EscrowState, SlaReportSeverity } from '../db/schema.js';

const eventCoder = new BorshEventCoder(bazaarEscrowIdl as unknown as Idl);

// See decoder.ts: Helius delivers base58. Anchor emit_cpi! adds an 8-byte
// IX tag prefix before the event discriminator; strip it for BorshEventCoder.
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

// IDL field names are snake_case; handlers want camelCase. Normalize.
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

// Anchor BorshEventCoder decodes Rust enums as { variantName: {} }.
type AnchorEnumObj = Record<string, Record<string, never>>;

export function decodeEscrowState(raw: AnchorEnumObj): EscrowState {
  const key = Object.keys(raw)[0];
  if (!key) throw new Error('Empty escrow state object from BorshEventCoder');
  if (key === 'timeoutClaimed') return 'timeout_claimed';
  return key as EscrowState;
}

export function decodeSlaSeverity(raw: AnchorEnumObj): SlaReportSeverity {
  const key = Object.keys(raw)[0];
  if (!key) throw new Error('Empty SLA severity object from BorshEventCoder');
  return key as SlaReportSeverity;
}

// Raw decoded shapes from BorshEventCoder:
//   pubkey  → PublicKey (.toString() → base58 string)
//   u64/i64 → BN       (.toString() → decimal string)
//   [u8;32] → number[]
type PubkeyLike = { toString(): string };
type BNLike = { toString(): string };

export type EscrowCreatedData = {
  escrow: PubkeyLike;
  buyer: PubkeyLike;
  seller: PubkeyLike;
  listing: PubkeyLike;
  amount: BNLike;
  deadlineTs: BNLike;
  createdAt: BNLike;
};

export type EscrowStateChangedData = {
  escrow: PubkeyLike;
  buyer: PubkeyLike;
  seller: PubkeyLike;
  oldState: AnchorEnumObj;
  newState: AnchorEnumObj;
  timestamp: BNLike;
};

export type DeliverySubmittedData = {
  escrow: PubkeyLike;
  seller: PubkeyLike;
  resultUri: string;
  resultHash: number[];
  deliveredAt: BNLike;
};

export type SlaReportData = {
  escrow: PubkeyLike;
  buyer: PubkeyLike;
  seller: PubkeyLike;
  severity: AnchorEnumObj;
  sellerBps: BNLike;
  refundBps: BNLike;
  score: number;
  tags: string[];
  confirmedAt: BNLike;
};

export type DisputeOpenedData = {
  escrow: PubkeyLike;
  buyer: PubkeyLike;
  reason: string;
  evidenceUri: string;
  openedAt: BNLike;
};

export type EscrowEvent =
  | { name: 'EscrowCreated'; data: EscrowCreatedData }
  | { name: 'EscrowStateChanged'; data: EscrowStateChangedData }
  | { name: 'DeliverySubmitted'; data: DeliverySubmittedData }
  | { name: 'SLAReport'; data: SlaReportData }
  | { name: 'DisputeOpened'; data: DisputeOpenedData };

const IDL_TO_EVENT_NAME: Record<string, EscrowEvent['name']> = {
  // BorshEventCoder may return either casing depending on Anchor version + IDL spec
  escrowCreated: 'EscrowCreated',
  EscrowCreated: 'EscrowCreated',
  escrowStateChanged: 'EscrowStateChanged',
  EscrowStateChanged: 'EscrowStateChanged',
  deliverySubmitted: 'DeliverySubmitted',
  DeliverySubmitted: 'DeliverySubmitted',
  slaReport: 'SLAReport',
  SLAReport: 'SLAReport',
  disputeOpened: 'DisputeOpened',
  DisputeOpened: 'DisputeOpened',
};

export function decodeEscrowEvent(data: string): EscrowEvent | null {
  try {
    const eventB64 = toEventBase64(data);
    if (!eventB64) return null;
    const decoded = eventCoder.decode(eventB64);
    if (!decoded) return null;
    const mappedName = IDL_TO_EVENT_NAME[decoded.name];
    if (!mappedName) return null;
    return { name: mappedName, data: normalizeKeys(decoded.data) } as EscrowEvent;
  } catch {
    return null;
  }
}
