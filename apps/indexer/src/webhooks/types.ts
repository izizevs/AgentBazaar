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
  description: z.string(),
  type: z.string(),
  source: z.string(),
  fee: z.number(),
  feePayer: z.string(),
  signature: z.string(),
  slot: z.number(),
  timestamp: z.number(),
  nativeTransfers: z.array(z.unknown()).optional(),
  tokenTransfers: z.array(z.unknown()).optional(),
  accountData: z.array(HeliusAccountDataSchema),
  transactionError: z.unknown().nullable().optional(),
  instructions: z.array(HeliusInstructionSchema),
  // events field is present for enhanced webhooks
  events: z.record(z.unknown()).optional(),
});

// A Helius webhook payload is an array of enhanced transaction objects.
export const HeliusWebhookPayloadSchema = z.array(HeliusEventSchema);

export type HeliusEvent = z.infer<typeof HeliusEventSchema>;
export type HeliusWebhookPayload = z.infer<typeof HeliusWebhookPayloadSchema>;
