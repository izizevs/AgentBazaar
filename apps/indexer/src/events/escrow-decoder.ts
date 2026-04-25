import { bazaarEscrowIdl } from '@agentbazaar/idl';
import type { Idl } from '@coral-xyz/anchor';
import { BorshEventCoder } from '@coral-xyz/anchor';

import type { EscrowState, SlaReportSeverity } from '../db/schema.js';

const eventCoder = new BorshEventCoder(bazaarEscrowIdl as unknown as Idl);

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
  escrowCreated: 'EscrowCreated',
  escrowStateChanged: 'EscrowStateChanged',
  deliverySubmitted: 'DeliverySubmitted',
  slaReport: 'SLAReport',
  disputeOpened: 'DisputeOpened',
};

export function decodeEscrowEvent(base64Data: string): EscrowEvent | null {
  try {
    const decoded = eventCoder.decode(base64Data);
    if (!decoded) return null;
    const mappedName = IDL_TO_EVENT_NAME[decoded.name];
    if (!mappedName) return null;
    return { name: mappedName, data: decoded.data } as EscrowEvent;
  } catch {
    return null;
  }
}
