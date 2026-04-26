import { z } from 'zod';

// Helius enhanced transaction webhook payload shapes.
// Ref: https://docs.helius.dev/webhooks-and-websockets/enhanced-transactions-api

export const HeliusAccountDataSchema = z.object({
  account: z.string(),
  nativeBalanceChange: z.number(),
  tokenBalanceChanges: z.array(z.unknown()),
});

export const HeliusInnerInstructionSchema = z.object({
  accounts: z.array(z.string()),
  data: z.string(),
  programId: z.string(),
});

export const HeliusInstructionSchema = z.object({
  accounts: z.array(z.string()),
  data: z.string(),
  programId: z.string(),
  innerInstructions: z.array(HeliusInnerInstructionSchema),
});

export const HeliusEventSchema = z.object({
  // Always-present fields per Helius enhanced transactions API
  signature: z.string(),
  slot: z.number(),
  timestamp: z.number(),
  description: z.string(),
  type: z.string(),
  source: z.string(),
  fee: z.number(),
  feePayer: z.string(),
  accountData: z.array(HeliusAccountDataSchema),
  instructions: z.array(HeliusInstructionSchema),
  // null on success, error object on failure — always present
  transactionError: z.unknown().nullable(),
  // Optional: absent when empty / not applicable
  nativeTransfers: z.array(z.unknown()).optional(),
  tokenTransfers: z.array(z.unknown()).optional(),
  events: z.record(z.unknown()).optional(),
  lighthouseData: z.unknown().optional(),
});

// A Helius webhook payload is an array of enhanced transaction objects.
export const HeliusWebhookPayloadSchema = z.array(HeliusEventSchema);

export type HeliusEvent = z.infer<typeof HeliusEventSchema>;
export type HeliusWebhookPayload = z.infer<typeof HeliusWebhookPayloadSchema>;
