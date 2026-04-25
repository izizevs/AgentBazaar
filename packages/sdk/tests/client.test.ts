import { Connection, Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AgentBazaar, AgentBazaarError, NotImplementedError } from '../src/index.js';

// Minimal Wallet stub that satisfies the Anchor Wallet interface.
function makeWallet(keypair = Keypair.generate()) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
}

const TEST_RPC = 'https://api.devnet.solana.com';

describe('AgentBazaar constructor', () => {
  it('accepts an RPC URL string and creates a Connection', () => {
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });
    expect(client.connection).toBeInstanceOf(Connection);
  });

  it('accepts an existing Connection instance', () => {
    const conn = new Connection(TEST_RPC);
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: conn });
    expect(client.connection).toBe(conn);
  });

  it('stores the wallet', () => {
    const wallet = makeWallet();
    const client = new AgentBazaar({ wallet, rpc: TEST_RPC });
    expect(client.wallet).toBe(wallet);
  });
});

describe('AgentBazaar stubs', () => {
  const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });

  const cases: Array<() => Promise<unknown>> = [
    () =>
      client.register({
        name: 'test',
        description: 'test agent',
        capability: 'cap',
        priceUsdc: 1_000_000n,
        pricingModel: 'per_request',
        sla: {},
        endpoint: 'https://example.com',
      }),
    () => client.discover({}),
    () => client.hire('agentId', { budget: 1_000_000n, sla: {}, timeout: 3600 }),
    () => client.deliver('escrowId', { resultUri: 'ipfs://x', resultHash: new Uint8Array(32) }),
    () => client.confirm('escrowId', { score: 90 }),
    () => client.claimTimeout('escrowId'),
    () => client.dispute('escrowId', { reason: 'bad output' }),
    () => client.requestEvaluation('escrowId'),
  ];

  for (const fn of cases) {
    it(`${fn.toString().match(/client\.(\w+)/)?.[1] ?? 'unknown'} throws NotImplementedError`, async () => {
      await expect(fn()).rejects.toBeInstanceOf(NotImplementedError);
    });
  }
});

describe('error hierarchy', () => {
  it('NotImplementedError is an AgentBazaarError', () => {
    expect(new NotImplementedError('test')).toBeInstanceOf(AgentBazaarError);
  });

  it('NotImplementedError message includes method name', () => {
    const err = new NotImplementedError('register');
    expect(err.message).toContain('register');
  });
});
