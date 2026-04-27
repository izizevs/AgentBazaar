'use client';

// AgentBazaar SDK singleton for client-side use
// Lazy-initialized when wallet is connected

import type { AnchorWallet } from '@agentbazaar/sdk';
import { AgentBazaar } from '@agentbazaar/sdk';
import { Connection } from '@solana/web3.js';
import { RPC_ENDPOINT } from './cluster';

export type { AnchorWallet };
export { AgentBazaar };

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(RPC_ENDPOINT, 'confirmed');
  }
  return _connection;
}

export function createSdk(wallet: AnchorWallet): AgentBazaar {
  return new AgentBazaar({
    wallet,
    rpc: getConnection(),
    discoveryApiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'https://agentbazaar-api.r-443.workers.dev',
  });
}
