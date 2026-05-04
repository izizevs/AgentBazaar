/**
 * Seed marketplace with sample agents for visual demo.
 *
 * Registers ~7 fake agents on devnet using SDK. Each is one Solana tx
 * (~0.001 SOL fee). No USDC needed (registration is free, only hire is paid).
 *
 * Run: pnpm tsx scripts/seed-agents.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AgentBazaar } from '@agentbazaar/sdk';

const DEVNET = 'https://api.devnet.solana.com';

const AGENTS = [
  {
    name: 'ContractAuditor',
    capability: 'security-audit',
    description: 'Automated static analysis of Anchor programs. Flags common CPI and signer-seeds vulnerabilities.',
    endpoint: 'https://contractauditor.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=ContractAuditor&backgroundColor=ffd1a8',
    priceUsdc: 80_000_000n,
    sla: { maxLatencyMs: 14400000, minUptimePct: 9970, responseFormat: 'text' },
  },
  {
    name: 'JupRouteOracle',
    capability: 'route-optimization',
    description: 'Real-time Jupiter route optimization with slippage forecasting across Solana DEXes.',
    endpoint: 'https://juproute.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=JupRouteOracle&backgroundColor=c8e6c9',
    priceUsdc: 120_000n,
    sla: { maxLatencyMs: 180, minUptimePct: 9992, responseFormat: 'json' },
  },
  {
    name: 'KaminoYieldStrategist',
    capability: 'yield-strategy',
    description: 'Auto-rebalancing yield strategy agent for Kamino, MarginFi, and Solend positions.',
    endpoint: 'https://kaminoyield.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=KaminoYieldStrategist&backgroundColor=b2dfdb',
    priceUsdc: 25_000_000n,
    sla: { maxLatencyMs: 3000, minUptimePct: 9900, responseFormat: 'json' },
  },
  {
    name: 'VaultSentry',
    capability: 'risk-monitoring',
    description: 'Continuous monitoring of vault health metrics: utilization, oracle drift, liquidation risk.',
    endpoint: 'https://vaultsentry.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=VaultSentry&backgroundColor=dcedc8',
    priceUsdc: 15_000_000n,
    sla: { maxLatencyMs: 5000, minUptimePct: 9950, responseFormat: 'json' },
  },
  {
    name: 'PythValidator',
    capability: 'feed-validation',
    description: 'Pyth price feed validation against Switchboard and CEX cross-reference; flags stale or anomalous prints.',
    endpoint: 'https://pythvalidator.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=PythValidator&backgroundColor=f0e6a8',
    priceUsdc: 8_000_000n,
    sla: { maxLatencyMs: 1000, minUptimePct: 9999, responseFormat: 'json' },
  },
  {
    name: 'BridgeRouter',
    capability: 'bridge-routing',
    description: 'Optimal bridge route selection across Wormhole, deBridge, and Allbridge with fee + speed scoring.',
    endpoint: 'https://bridgerouter.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=BridgeRouter&backgroundColor=ffccbc',
    priceUsdc: 5_000_000n,
    sla: { maxLatencyMs: 800, minUptimePct: 9980, responseFormat: 'json' },
  },
  {
    name: 'NewsDigester',
    capability: 'news-summary',
    description: 'Crypto news aggregation + LLM summary every 4h. Twitter, Discord, governance forums.',
    endpoint: 'https://newsdigester.example/api',
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=NewsDigester&backgroundColor=d1c4e9',
    priceUsdc: 2_000_000n,
    sla: { maxLatencyMs: 14400000, minUptimePct: 9900, responseFormat: 'text' },
  },
];

function loadMaster(): Keypair {
  const raw = JSON.parse(
    readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'),
  ) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function makeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends { sign: (...args: any[]) => any }>(tx: T): Promise<T> {
      tx.sign(kp);
      return tx;
    },
    async signAllTransactions<T extends { sign: (...args: any[]) => any }>(txs: T[]): Promise<T[]> {
      txs.forEach((t) => t.sign(kp));
      return txs;
    },
  };
}

async function main() {
  const conn = new Connection(DEVNET, 'confirmed');
  const master = loadMaster();
  const wallet = makeWallet(master);
  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) throw new Error('PINATA_JWT not set in env');

  const bazaar = new AgentBazaar({ rpc: conn, wallet, pinataJwt });

  console.log(`\nSeeding ${AGENTS.length} agents from ${master.publicKey.toBase58()}\n`);

  for (const [i, a] of AGENTS.entries()) {
    try {
      console.log(`[${i + 1}/${AGENTS.length}] Registering ${a.name}...`);
      const result = await bazaar.register({
        name: a.name,
        capability: a.capability,
        description: a.description,
        endpoint: a.endpoint,
        avatar: a.avatar,
        priceUsdc: a.priceUsdc,
        pricingModel: 'per_request',
        sla: a.sla,
      });
      console.log(`  ✓ listing ${result.listing.toBase58().slice(0, 12)}... tx ${result.signature.slice(0, 12)}...`);
    } catch (err) {
      console.log(`  ✗ ${(err as Error).message}`);
    }
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
