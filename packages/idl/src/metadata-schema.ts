import { z } from 'zod';

/**
 * Zod schema for the JSON payload stored at the metadata_uri field of
 * ServiceListing PDAs (PRD §6.1).  The SHA-256 of the `capability` string
 * is the on-chain capability_hash — keep them in sync via computeCapabilityHash.
 */
export const MetadataSchema = z.object({
  /** Human-readable service name (1–64 chars). */
  name: z.string().min(1).max(64),
  /** Service description (≤500 chars). */
  description: z.string().max(500),
  /**
   * Stable capability identifier.  SHA-256(capability) == on-chain
   * capability_hash stored in ServiceListing.
   */
  capability: z.string().min(1).max(256),
  /** Optional agent avatar URL (HTTPS only). */
  avatar: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'Avatar must use HTTPS')
    .optional(),
  /** Arbitrary extension key/value pairs. */
  custom: z.record(z.string(), z.unknown()).optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * Returns the SHA-256 digest of `capability` as a 32-byte Uint8Array.
 * This must match the `capability_hash` seeds used in the on-chain PDA
 * derivation.  Uses the Web Crypto API (available in Node 20+ and all
 * modern browsers).
 */
export async function computeCapabilityHash(capability: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(capability);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(buf);
}
