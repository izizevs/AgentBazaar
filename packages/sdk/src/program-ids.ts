/**
 * Per-cluster program ID table for all AgentBazaar on-chain programs.
 *
 * Use `clusterFromConnection(conn)` to resolve the active cluster from a
 * `Connection` endpoint, then look up the appropriate program IDs via
 * `PROGRAM_IDS[cluster]`.
 *
 * Mainnet-beta and testnet entries are placeholders (SystemProgram ID) until M2 deploy.
 */
import { type Connection, PublicKey } from '@solana/web3.js';
import { UnknownClusterError } from './errors.js';

export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';

export interface ProgramAddresses {
  registry: PublicKey;
  escrow: PublicKey;
  sla: PublicKey;
  evaluator: PublicKey;
}

/** Placeholder for programs not yet deployed on a cluster (M2+). */
const NOT_YET_DEPLOYED = new PublicKey('11111111111111111111111111111111');

/**
 * Per-cluster canonical program IDs.
 *
 * - `devnet` / `localnet`: live M1 IDs from PR #76.
 * - `testnet` / `mainnet-beta`: placeholder until M2 deploy.
 */
export const PROGRAM_IDS: Record<Cluster, ProgramAddresses> = {
  devnet: {
    registry: new PublicKey('ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3'),
    escrow: new PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2'),
    sla: new PublicKey('26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8'),
    evaluator: new PublicKey('BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8'),
  },
  localnet: {
    // localnet uses the same deploy IDs as devnet during development
    registry: new PublicKey('ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3'),
    escrow: new PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2'),
    sla: new PublicKey('26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8'),
    evaluator: new PublicKey('BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8'),
  },
  testnet: {
    // Not yet deployed — placeholders until M2
    registry: NOT_YET_DEPLOYED,
    escrow: NOT_YET_DEPLOYED,
    sla: NOT_YET_DEPLOYED,
    evaluator: NOT_YET_DEPLOYED,
  },
  'mainnet-beta': {
    // Not yet deployed — placeholders until M2
    registry: NOT_YET_DEPLOYED,
    escrow: NOT_YET_DEPLOYED,
    sla: NOT_YET_DEPLOYED,
    evaluator: NOT_YET_DEPLOYED,
  },
};

/**
 * Explicit hostname allowlist for cluster detection.
 *
 * Matching is done against the URL hostname (not the full URL string), which
 * prevents path/query-parameter injection attacks such as:
 *   https://mainnet-proxy.example.com/devnet-shadow → hostname is
 *   "mainnet-proxy.example.com", which matches mainnet-beta, not devnet.
 *
 * Each cluster has an ordered list of regexp patterns. The first matching
 * cluster wins (order: localnet, devnet, testnet, mainnet-beta).
 */
const CLUSTER_HOSTS: Record<Cluster, RegExp[]> = {
  localnet: [/^localhost$/, /^127\.0\.0\.1$/, /^0\.0\.0\.0$/],
  devnet: [
    /^api\.devnet\.solana\.com$/,
    /^devnet\.helius-rpc\.com$/,
    /^[a-z0-9-]+\.devnet\.solana\.com$/,
  ],
  testnet: [/^api\.testnet\.solana\.com$/],
  'mainnet-beta': [
    /^api\.mainnet-beta\.solana\.com$/,
    /^mainnet\.helius-rpc\.com$/,
    /^solana-api\.projectserum\.com$/,
    /^[a-z0-9-]+\.mainnet-beta\.solana\.com$/,
  ],
};

/** Ordered list for deterministic matching (localnet first, mainnet last). */
const CLUSTER_MATCH_ORDER: Cluster[] = ['localnet', 'devnet', 'testnet', 'mainnet-beta'];

export interface ClusterFromConnectionOptions {
  /** If provided, skip hostname detection and return this value directly. */
  override?: Cluster;
}

/**
 * Resolve the Solana cluster from a `Connection`'s RPC endpoint URL.
 *
 * Detection is performed against the URL **hostname** (not the full URL string)
 * to prevent substring-injection attacks (e.g. a path component containing
 * "devnet" on a mainnet proxy would previously return `'devnet'`).
 *
 * Pass `{ override }` to skip detection entirely and use a caller-supplied cluster.
 *
 * Recognised hostname patterns:
 * - `localhost`, `127.0.0.1`, `0.0.0.0` → `'localnet'`
 * - `api.devnet.solana.com`, `devnet.helius-rpc.com`, `*.devnet.*` → `'devnet'`
 * - `api.testnet.solana.com` → `'testnet'`
 * - `api.mainnet-beta.solana.com`, `mainnet.helius-rpc.com`, `*.mainnet.*` → `'mainnet-beta'`
 *
 * @throws {UnknownClusterError} if the hostname cannot be mapped and no override is supplied.
 */
export function clusterFromConnection(
  connection: Connection,
  options?: ClusterFromConnectionOptions,
): Cluster {
  if (options?.override !== undefined) {
    return options.override;
  }

  let hostname: string;
  try {
    hostname = new URL(connection.rpcEndpoint).hostname;
  } catch {
    // Fallback for bare host:port strings (e.g. "localhost:8899")
    hostname = (connection.rpcEndpoint.split(':')[0] ?? '').replace(/^https?:\/\//, '');
  }

  for (const cluster of CLUSTER_MATCH_ORDER) {
    for (const pattern of CLUSTER_HOSTS[cluster]) {
      if (pattern.test(hostname)) {
        return cluster;
      }
    }
  }

  throw new UnknownClusterError(connection.rpcEndpoint);
}
