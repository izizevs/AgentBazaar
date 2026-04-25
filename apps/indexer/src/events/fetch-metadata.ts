import type { Metadata } from '@agentbazaar/idl';
import { MetadataSchema } from '@agentbazaar/idl';
import { logger } from '../logger.js';

// Resolve an IPFS CID URI to an HTTP gateway URL.
// Prefers PINATA_GATEWAY env when set; falls back to public ipfs.io.
function resolveIpfsUrl(uri: string): string {
  if (!uri.startsWith('ipfs://')) return uri;
  const cid = uri.slice('ipfs://'.length);
  const gateway = process.env.PINATA_GATEWAY ?? 'https://ipfs.io/ipfs';
  return `${gateway}/${cid}`;
}

export async function fetchMetadata(metadataUri: string): Promise<Metadata | null> {
  const url = resolveIpfsUrl(metadataUri);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'metadata fetch failed');
      return null;
    }
    const json = await res.json();
    const parsed = MetadataSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn({ url, issues: parsed.error.issues }, 'metadata schema validation failed');
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn({ url, err }, 'metadata fetch error');
    return null;
  }
}
