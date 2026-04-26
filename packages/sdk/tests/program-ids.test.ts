import type { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { UnknownClusterError } from '../src/errors.js';
import { clusterFromConnection, PROGRAM_IDS } from '../src/program-ids.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function conn(endpoint: string): Connection {
  // Connection only reads rpcEndpoint — no live RPC needed for these tests.
  return { rpcEndpoint: endpoint } as unknown as Connection;
}

// ─── clusterFromConnection ─────────────────────────────────────────────────────

describe('clusterFromConnection', () => {
  it('returns devnet for api.devnet.solana.com', () => {
    expect(clusterFromConnection(conn('https://api.devnet.solana.com'))).toBe('devnet');
  });

  it('returns devnet for Helius devnet endpoint', () => {
    expect(clusterFromConnection(conn('https://devnet.helius-rpc.com/?api-key=abc123'))).toBe(
      'devnet',
    );
  });

  it('returns devnet for Helius mainnet-style URL that contains "devnet" in path', () => {
    expect(clusterFromConnection(conn('https://rpc.helius.xyz/devnet/?api-key=abc123'))).toBe(
      'devnet',
    );
  });

  it('returns localnet for localhost', () => {
    expect(clusterFromConnection(conn('http://localhost:8899'))).toBe('localnet');
  });

  it('returns localnet for 127.0.0.1', () => {
    expect(clusterFromConnection(conn('http://127.0.0.1:8899'))).toBe('localnet');
  });

  it('returns testnet for api.testnet.solana.com', () => {
    expect(clusterFromConnection(conn('https://api.testnet.solana.com'))).toBe('testnet');
  });

  it('returns mainnet-beta for api.mainnet-beta.solana.com', () => {
    expect(clusterFromConnection(conn('https://api.mainnet-beta.solana.com'))).toBe('mainnet-beta');
  });

  it('returns mainnet-beta for an endpoint containing "mainnet"', () => {
    expect(clusterFromConnection(conn('https://mainnet.helius-rpc.com/?api-key=abc'))).toBe(
      'mainnet-beta',
    );
  });

  it('throws UnknownClusterError for an unrecognised endpoint', () => {
    const endpoint = 'https://unknown-rpc.example.com';
    expect(() => clusterFromConnection(conn(endpoint))).toThrowError(UnknownClusterError);
    expect(() => clusterFromConnection(conn(endpoint))).toThrowError(
      /Cannot determine Solana cluster from RPC endpoint/,
    );
  });

  it('UnknownClusterError carries the endpoint', () => {
    const endpoint = 'https://private-rpc.acme.xyz';
    let thrown: UnknownClusterError | undefined;
    try {
      clusterFromConnection(conn(endpoint));
    } catch (e) {
      if (e instanceof UnknownClusterError) thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownClusterError);
    expect(thrown?.endpoint).toBe(endpoint);
  });
});

// ─── PROGRAM_IDS table ────────────────────────────────────────────────────────

describe('PROGRAM_IDS', () => {
  it('has an entry for devnet', () => {
    expect(PROGRAM_IDS.devnet).toBeDefined();
  });

  it('devnet registry ID matches M1 deploy', () => {
    expect(PROGRAM_IDS.devnet.registry.toBase58()).toBe(
      'ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3',
    );
  });

  it('devnet escrow ID matches M1 deploy', () => {
    expect(PROGRAM_IDS.devnet.escrow.toBase58()).toBe(
      'EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2',
    );
  });

  it('devnet sla ID matches M1 deploy', () => {
    expect(PROGRAM_IDS.devnet.sla.toBase58()).toBe('26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8');
  });

  it('devnet evaluator ID matches M1 deploy', () => {
    expect(PROGRAM_IDS.devnet.evaluator.toBase58()).toBe(
      'BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8',
    );
  });

  it('localnet IDs match devnet IDs (shared deploy for development)', () => {
    expect(PROGRAM_IDS.localnet.registry.toBase58()).toBe(PROGRAM_IDS.devnet.registry.toBase58());
    expect(PROGRAM_IDS.localnet.escrow.toBase58()).toBe(PROGRAM_IDS.devnet.escrow.toBase58());
  });

  it('has placeholder entries for mainnet-beta and testnet', () => {
    // These are not yet deployed — they should exist in the table but not match devnet IDs
    expect(PROGRAM_IDS['mainnet-beta']).toBeDefined();
    expect(PROGRAM_IDS.testnet).toBeDefined();
  });
});
