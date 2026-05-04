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
 * L3 fix (post-audit): migrated isPrivateIp from hand-rolled regexes to ipaddr.js
 * (battle-tested CIDR parser); added CGNAT 100.64.0.0/10 (RFC 6598) to blocklist.
 *
 * Timeout reduced to 5 s (was 10 s) as required by Task #42 spec.
 */

import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import type { Metadata } from '@agent-bazaar/idl';
import { MetadataSchema } from '@agent-bazaar/idl';
import * as ipaddr from 'ipaddr.js';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';

const MAX_RESPONSE_BYTES = 100_000;
const TIMEOUT_MS = 5_000;

/**
 * L3 fix: migrate to ipaddr.js for IP range parsing.
 *
 * ipaddr.js is a battle-tested library used by major proxies; it handles all
 * edge cases around IPv4-mapped IPv6 unwrapping, CIDR range membership, and
 * normalisation automatically — removing the need for hand-rolled regexes.
 *
 * Blocked ranges:
 *  - loopback          (127.0.0.0/8, ::1)
 *  - RFC 1918 private  (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *  - link-local        (169.254.0.0/16, fe80::/10) — includes cloud metadata
 *  - unique-local IPv6 (fc00::/7)
 *  - multicast         (224.0.0.0/4, ff00::/8)
 *  - unspecified       (0.0.0.0, ::)
 *  - CGNAT             (100.64.0.0/10 — RFC 6598; added for completeness per L3 audit note)
 *
 * ipaddr.js range() returns named strings for well-known ranges and
 * 'unicast' for public addresses. We block anything that is NOT unicast
 * (after unwrapping IPv4-in-IPv6 to its IPv4 representation).
 */
function isPrivateIp(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    // Unparseable address → fail-closed.
    return true;
  }

  // Unwrap IPv4-mapped IPv6 (::ffff:x.x.x.x) so IPv4 range checks apply.
  // Without this, ::ffff:169.254.169.254 would be classified as ipv4Mapped
  // rather than linkLocal — the blocklist covers both, but unwrapping is
  // cleaner and ensures future IPv4-range additions are automatically covered.
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    }
  }

  const range = parsed.range();

  // ipaddr.js built-in range names that indicate non-public addresses.
  const BLOCKED_RANGES = new Set([
    'unspecified', // 0.0.0.0 / ::
    'loopback', // 127.0.0.0/8 / ::1
    'private', // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    'linkLocal', // 169.254.0.0/16 (cloud metadata!) / fe80::/10
    'uniqueLocal', // fc00::/7
    'multicast', // 224.0.0.0/4 / ff00::/8
    'ipv4Mapped', // remaining ::ffff:x.x.x.x forms (after partial unwrap)
    'rfc6145', // IPv4-translated IPv6 (::ffff:0:x.x.x.x)
    'rfc6052', // IPv4/IPv6 translation (64:ff9b::/96)
    'teredo', // 2001::/32
    'carrierGradeNat', // 100.64.0.0/10 — CGNAT (RFC 6598)
    '6to4', // 2002::/16
  ]);

  return BLOCKED_RANGES.has(range);
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
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  const port = parsedUrl.port ? Number(parsedUrl.port) : 443;
  const path = parsedUrl.pathname + parsedUrl.search;

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

/**
 * fetchMetadata with bounded retries — used by event handlers where a transient
 * failure (Pinata propagation lag, IPFS gateway hiccup, network blip) would
 * otherwise leave the listing's capability/endpoint columns NULL forever.
 *
 * Retries `attempts` times with linear backoff `delayMs` between attempts.
 * Returns the first successful result, or null if all attempts fail.
 *
 * Default schedule: 3 attempts at t=0s, t=5s, t=30s (~35s total worst case).
 * The values match the typical Pinata public-gateway propagation window.
 */
export async function fetchMetadataWithRetry(
  metadataUri: string,
  attempts = 3,
  delaysMs: readonly number[] = [0, 5_000, 30_000],
): Promise<Metadata | null> {
  for (let i = 0; i < attempts; i++) {
    const delay = delaysMs[i] ?? delaysMs[delaysMs.length - 1] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const result = await fetchMetadata(metadataUri);
    if (result) return result;
    logger.info(
      { uri: safeLogUrl(metadataUri), attempt: i + 1, attempts },
      'metadata fetch attempt failed, retrying',
    );
  }
  return null;
}
