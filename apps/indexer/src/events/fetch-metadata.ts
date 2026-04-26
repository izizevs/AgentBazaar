/**
 * fetchMetadata — SSRF-hardened metadata fetcher (Task #43).
 *
 * Four-layer SSRF defence (original design from PR #44):
 *  1. Scheme allowlist: https:// only (or ipfs:// translated to gateway https://).
 *  2. Private-IP DNS block: rejects RFC 1918 + loopback + link-local addresses.
 *  3. No redirects: 3xx status codes are treated as errors.
 *  4. Response-size cap: 100 KB streaming limit (I1 fix — no full-buffer before check).
 *
 * I1 (audit note): replaced `res.text()` + post-check with a streaming
 * ReadableStream byte-counter that aborts as soon as the limit is hit, preventing
 * a 10 s × bandwidth body from being held in memory.
 *
 * I2 (audit note): replaced global `fetch` with `node:https.request` + a custom
 * `https.Agent` whose `lookup` hook pre-resolves the hostname, validates the IP,
 * and pins it for the TLS connection. This defeats DNS rebinding: the OS cannot
 * make a second, attacker-controlled DNS resolution at connect time.
 *
 * H1 fix (post-audit): `isPrivateIp` now lowercases before matching, unwraps
 * IPv4-mapped IPv6 (::ffff:x.x.x.x) so the IPv4 blocklist applies, and also
 * blocks 0.0.0.0 / :: (unspecified) and ff::/8 (multicast).
 *
 * L1 fix (post-audit): lookup hook now passes `result.family` instead of the
 * hardcoded `4`, correctly supporting IPv6-only resolvers.
 *
 * Timeout reduced to 5 s (was 10 s) as required by Task #42 spec.
 */

import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import type { Metadata } from '@agentbazaar/idl';
import { MetadataSchema } from '@agentbazaar/idl';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';

const MAX_RESPONSE_BYTES = 100_000;
const TIMEOUT_MS = 5_000;

// RFC 1918 + loopback + link-local + cloud metadata — blocked to prevent SSRF
// against internal services (169.254.169.254 cloud metadata endpoint, etc.).
const PRIVATE_IPV4 = [
  /^127\./, // 127.0.0.0/8  loopback
  /^10\./, // 10.0.0.0/8   RFC 1918
  /^192\.168\./, // 192.168.0.0/16 RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 RFC 1918
  /^169\.254\./, // 169.254.0.0/16 link-local / cloud metadata
];

function isPrivateIp(address: string): boolean {
  // Normalise to lowercase so uppercase IPv6 literals don't slip through.
  let addr = address.toLowerCase();

  // Unwrap IPv4-mapped IPv6 (::ffff:x.x.x.x) so the IPv4 blocklist applies.
  // Without this, ::ffff:169.254.169.254 bypasses the PRIVATE_IPV4 regexes.
  if (addr.startsWith('::ffff:')) {
    const tail = addr.slice('::ffff:'.length);
    if (isIPv4(tail)) addr = tail;
  }

  // Unspecified addresses — block both forms.
  if (addr === '0.0.0.0' || addr === '::') return true;

  return (
    PRIVATE_IPV4.some((re) => re.test(addr)) ||
    addr === '::1' || // IPv6 loopback
    addr.startsWith('fe80:') || // fe80::/10 link-local
    addr.startsWith('fc') || // fc00::/7 unique-local
    addr.startsWith('fd') || // fc00::/7 unique-local (fd prefix)
    addr.startsWith('ff') // ff00::/8 multicast
  );
}

// Returns null for non-https://, non-ipfs:// schemes or invalid CIDs.
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

/**
 * I1 fix: stream the response body, counting bytes as they arrive.
 * Returns null if the body exceeds maxBytes — no full-body buffer is
 * held in memory before the size check.
 */
async function readBodyWithLimit(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as string);
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * I2 fix: HTTPS request with DNS pinning.
 *
 * Resolves the hostname exactly once, validates the resulting IP against
 * the private-IP blocklist, then constructs an `https.Agent` whose
 * `lookup` hook always returns the pre-validated IP — preventing a second
 * OS-level DNS resolution at connect time that could return a different
 * (attacker-controlled) address (DNS rebinding attack).
 *
 * The original hostname is preserved as the TLS `servername` (SNI) and
 * `Host` header so certificate validation works correctly.
 *
 * Returns null on DNS failure, private IP, or any network error.
 * Redirects are treated as errors (Layer 3 defence; matches original
 * `redirect: 'error'` semantics).
 */
async function httpsGetPinned(url: string): Promise<{
  statusCode: number;
  stream: NodeJS.ReadableStream;
} | null> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 443;
  const path = parsed.pathname + parsed.search;

  // Step 1: Resolve + validate once.
  let resolvedIp: string;
  let resolvedFamily: number;
  try {
    const result: LookupAddress = await dnsLookup(hostname);
    resolvedIp = result.address;
    resolvedFamily = result.family;
  } catch {
    return null; // DNS failure → fail-closed
  }

  if (isPrivateIp(resolvedIp)) {
    return null;
  }

  // Step 2: Custom agent whose lookup hook returns the pre-validated IP.
  // node:https.Agent will call this hook instead of the OS resolver, so
  // there is no second DNS lookup between our validation and the TCP connect.
  const agent = new https.Agent({
    lookup: (
      _host: string,
      _opts: LookupOptions,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      cb(null, resolvedIp, resolvedFamily);
    },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        agent,
        // Connect to the pre-resolved IP — OS won't do another lookup.
        hostname: resolvedIp,
        port,
        path,
        method: 'GET',
        headers: {
          Host: hostname,
          'User-Agent': 'agentbazaar-indexer/0.1',
        },
        // TLS SNI — ensures cert validation uses the original hostname,
        // not the numeric IP.
        servername: hostname,
        rejectUnauthorized: true,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        resolve({ statusCode: res.statusCode ?? 0, stream: res });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });

    req.on('error', () => {
      resolve(null);
    });

    req.end();
  });
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

  const response = await httpsGetPinned(url);

  if (!response) {
    logger.warn(
      { url: safeLogUrl(url) },
      'metadata fetch rejected: DNS/network failure or private address',
    );
    return null;
  }

  const { statusCode, stream } = response;

  // Treat redirects (3xx) as errors — matches original redirect: 'error' behaviour.
  if (statusCode >= 300 && statusCode < 400) {
    logger.warn({ url: safeLogUrl(url), statusCode }, 'metadata fetch rejected: redirect');
    return null;
  }

  if (statusCode < 200 || statusCode >= 300) {
    logger.warn({ url: safeLogUrl(url), statusCode }, 'metadata fetch failed: non-2xx status');
    return null;
  }

  // I1 fix: streaming byte-counter — never buffers >100 KB.
  let text: string | null;
  try {
    text = await readBodyWithLimit(stream, MAX_RESPONSE_BYTES);
  } catch (err) {
    logger.warn({ url: safeLogUrl(url), err }, 'metadata fetch error reading body');
    return null;
  }

  if (text === null) {
    logger.warn(
      { url: safeLogUrl(url), maxBytes: MAX_RESPONSE_BYTES },
      'metadata fetch rejected: body too large',
    );
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.warn({ url: safeLogUrl(url) }, 'metadata fetch rejected: invalid JSON');
    return null;
  }

  const parsed = MetadataSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { url: safeLogUrl(url), issues: parsed.error.issues },
      'metadata schema validation failed',
    );
    return null;
  }

  return parsed.data;
}
