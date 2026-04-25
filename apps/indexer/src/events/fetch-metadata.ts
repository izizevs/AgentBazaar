import { lookup } from 'node:dns/promises';
import type { Metadata } from '@agentbazaar/idl';
import { MetadataSchema } from '@agentbazaar/idl';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';

const MAX_RESPONSE_BYTES = 100_000;

// RFC 1918 + loopback + link-local — blocked to prevent SSRF against cloud
// metadata endpoints (169.254.169.254) and internal services.
const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
];

// Returns null for non-ipfs://, non-https:// schemes or invalid CIDs.
function resolveIpfsUrl(uri: string): string | null {
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice('ipfs://'.length);
    // CID must be alphanumeric — rejects path traversal like "../other-path".
    if (!/^[a-zA-Z0-9]+$/.test(cid)) return null;
    const gateway = process.env.PINATA_GATEWAY ?? 'https://ipfs.io/ipfs';
    return `${gateway}/${cid}`;
  }
  if (uri.startsWith('https://')) return uri;
  return null;
}

async function isPrivateAddress(url: string): Promise<boolean> {
  try {
    const { address } = await lookup(new URL(url).hostname);
    return (
      PRIVATE_IPV4.some((re) => re.test(address)) ||
      address === '::1' ||
      address.startsWith('fe80::')
    );
  } catch {
    // DNS failure → treat as blocked (fail-closed).
    return true;
  }
}

export async function fetchMetadata(metadataUri: string): Promise<Metadata | null> {
  const url = resolveIpfsUrl(metadataUri);
  if (!url) {
    logger.warn(
      { uri: safeLogUrl(metadataUri) },
      'metadata fetch rejected: scheme not allowed or invalid CID',
    );
    return null;
  }

  if (await isPrivateAddress(url)) {
    logger.warn({ url: safeLogUrl(url) }, 'metadata fetch rejected: private/loopback address');
    return null;
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!res.ok) {
      logger.warn({ url: safeLogUrl(url), status: res.status }, 'metadata fetch failed');
      return null;
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_RESPONSE_BYTES) {
      logger.warn(
        { url: safeLogUrl(url), contentLength },
        'metadata fetch rejected: response too large',
      );
      return null;
    }

    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      logger.warn(
        { url: safeLogUrl(url), length: text.length },
        'metadata fetch rejected: body too large',
      );
      return null;
    }

    const json = JSON.parse(text) as unknown;
    const parsed = MetadataSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { url: safeLogUrl(url), issues: parsed.error.issues },
        'metadata schema validation failed',
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn({ url: safeLogUrl(url), err }, 'metadata fetch error');
    return null;
  }
}
