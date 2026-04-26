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
 * Resolve the Solana cluster from a `Connection`'s RPC endpoint URL.
 *
 * Recognised patterns:
 * - `*.devnet.solana.com` → `'devnet'`
 * - `*devnet*` (e.g. Helius devnet) → `'devnet'`
 * - `localhost` / `127.0.0.1` → `'localnet'`
 * - `*.testnet.solana.com` / `*testnet*` → `'testnet'`
 * - `*mainnet*` / `*.mainnet-beta.solana.com` → `'mainnet-beta'`
 *
 * @throws {UnknownClusterError} if the endpoint cannot be mapped to a known cluster.
 */
export function clusterFromConnection(connection: Connection): Cluster {
  const endpoint = connection.rpcEndpoint.toLowerCase();

  if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
    return 'localnet';
  }
  if (endpoint.includes('devnet')) {
    return 'devnet';
  }
  if (endpoint.includes('testnet')) {
    return 'testnet';
  }
  if (endpoint.includes('mainnet')) {
    return 'mainnet-beta';
  }

  throw new UnknownClusterError(connection.rpcEndpoint);
}
