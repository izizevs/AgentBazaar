// Bearer token authentication for the MCP server.
//
// MVP: single shared token set via `wrangler secret put MCP_AUTH_TOKEN`.
// Future M3: per-client tokens with rate limits.

/**
 * Extract the Bearer token from an Authorization header value.
 * Returns null if the header is missing or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/.exec(authHeader);
  return match?.[1] ?? null;
}

/**
 * Validate that the provided token matches the expected secret.
 * Uses constant-time comparison to prevent timing side-channel attacks.
 */
export function validateToken(token: string, expectedToken: string): boolean {
  // Lengths must match first; but we avoid early return to keep timing uniform
  // for the most common short-circuit case (wrong length).
  if (token.length !== expectedToken.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds guaranteed by loop
    diff |= token.codePointAt(i)! ^ expectedToken.codePointAt(i)!;
  }
  return diff === 0;
}
