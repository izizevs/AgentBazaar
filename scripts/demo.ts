#!/usr/bin/env tsx

/**
 * demo.ts — autonomous 2-agent escrow lifecycle on Solana devnet.
 *
 * Usage:
 *   pnpm demo
 *
 * What it does:
 *   Setup → Generate agent keypairs → Provider registers service →
 *   Buyer discovers → Buyer hires (1 USDC escrow) → Provider delivers →
 *   Buyer confirms → Verify reputation → Summary box
 *
 * Prerequisites:
 *   - Master wallet ~/.config/solana/id.json (or SOLANA_KEYPAIR_PATH env)
 *     funded with ≥0.5 SOL + ≥3 USDC on devnet
 *   - PINATA_JWT env var (or in root .env)
 *
 * Task #61 — M3-W1.B
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Load .env from repo root before anything else ─────────────────────────────
const require = createRequire(import.meta.url);
try {
  // dotenv is available transitively; fall back silently if it's not
  const dotenv = require('dotenv');
  // Try: (1) CWD/.env — for running from workspace root
  //      (2) ../. env relative to this script — for running from scripts/ dir
  const candidates = [
    join(process.cwd(), '.env'),
    join(new URL('..', import.meta.url).pathname, '.env'),
  ];
  for (const candidate of candidates) {
    const result = dotenv.config({ path: candidate, override: false });
    if (!result.error) break;
  }
} catch {
  // not critical — env may be set by the shell already
}

import { AgentBazaar, DegradedDiscoveryError, type ServiceProvider } from '@agentbazaar/sdk';
import { Wallet } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  transferChecked,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

// ── ANSI colour helpers (no external dep) ────────────────────────────────────

const isTTY = process.stdout.isTTY;

function ansi(code: string, text: string): string {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const c = {
  cyan: (t: string) => ansi('36', t),
  yellow: (t: string) => ansi('33', t),
  green: (t: string) => ansi('32', t),
  magenta: (t: string) => ansi('35', t),
  bold: (t: string) => ansi('1', t),
  dim: (t: string) => ansi('2', t),
  red: (t: string) => ansi('31', t),
};

// ── Simple spinner (no external dep) ─────────────────────────────────────────

function makeSpinner(label: string) {
  if (!isTTY) {
    process.stdout.write(`${c.dim(`  ${label}...`)}\n`);
    return { stop: (_final?: string) => {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    const frame = frames[i % frames.length] ?? '⠋';
    process.stdout.write(`\r  ${c.cyan(frame)} ${label}   `);
    i++;
  }, 100);
  return {
    stop: (final?: string) => {
      clearInterval(timer);
      if (final) {
        process.stdout.write(`\r  ${final}\n`);
      } else {
        process.stdout.write('\r');
      }
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function explorerTx(sig: string): string {
  return c.magenta(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

function explorerAccount(addr: string): string {
  return c.magenta(`https://explorer.solana.com/address/${addr}?cluster=devnet`);
}

function section(title: string) {
  console.log('');
  console.log(c.bold(c.cyan(`▶ ${title}`)));
}

function ok(msg: string) {
  console.log(`  ${c.green('✓')} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${c.cyan('·')} ${msg}`);
}

async function makeKeypairWallet(keypair: Keypair): Promise<Wallet> {
  return new Wallet(keypair);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const BUDGET_MICRO = 1_000_000n; // 1.00 USDC
const BUYER_FUND_MICRO = 1_500_000n; // 1.50 USDC
const SOL_FUND = 0.015 * LAMPORTS_PER_SOL; // 0.015 SOL each
const DISCOVERY_API_URL = 'https://agentbazaar-api.r-443.workers.dev';
const MIN_MASTER_SOL = 0.15 * LAMPORTS_PER_SOL;
const MIN_MASTER_USDC_MICRO = 2_000_000n; // 2 USDC
const CAPABILITY = `translate-text-demo-${Date.now()}`;

// ── Load master keypair ───────────────────────────────────────────────────────

function loadMasterKeypair(): Keypair {
  const keyPath =
    process.env.SOLANA_KEYPAIR_PATH ??
    process.env.KEYPAIR_PATH ??
    join(homedir(), '.config', 'solana', 'id.json');

  let raw: number[];
  try {
    raw = JSON.parse(readFileSync(keyPath, 'utf8')) as number[];
  } catch (err) {
    console.error(c.red(`\n  ERROR: Cannot read master keypair at ${keyPath}`));
    console.error(c.red(`  ${(err as Error).message}`));
    console.error('');
    console.error('  To fund a devnet wallet:');
    console.error('    • SOL: https://faucet.solana.com');
    console.error('    • USDC: https://faucet.circle.com (select "Devnet")');
    process.exit(1);
  }

  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ── Transfer SOL from master → recipient ─────────────────────────────────────

async function fundSol(
  connection: Connection,
  master: Keypair,
  recipient: PublicKey,
  lamports: number,
): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: master.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: master.publicKey, toPubkey: recipient, lamports }),
  );
  tx.sign(master);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
}

// ── Transfer USDC from master ATA → recipient ATA ────────────────────────────

async function fundUsdc(
  connection: Connection,
  master: Keypair,
  recipient: PublicKey,
  amountMicro: bigint,
): Promise<void> {
  const masterAta = await getOrCreateAssociatedTokenAccount(
    connection,
    master,
    DEVNET_USDC_MINT,
    master.publicKey,
  );
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    master,
    DEVNET_USDC_MINT,
    recipient,
  );
  if (amountMicro > 0n) {
    await transferChecked(
      connection,
      master,
      masterAta.address,
      DEVNET_USDC_MINT,
      recipientAta.address,
      master,
      amountMicro,
      6,
    );
  }
}

// ── USDC balance helper ───────────────────────────────────────────────────────

async function getUsdcBalance(connection: Connection, owner: PublicKey): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, owner);
    const bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

function microToDisplay(micro: bigint): string {
  return `$${(Number(micro) / 1_000_000).toFixed(2)}`;
}

// ── Discovery with retry/spinner ─────────────────────────────────────────────

async function discoverWithRetry(
  buyerBazaar: AgentBazaar,
  listingPubkey: string,
  maxWaitMs = 90_000,
): Promise<ServiceProvider | undefined> {
  const start = Date.now();
  const spinner = makeSpinner('Waiting for indexer to index the new listing');

  while (Date.now() - start < maxWaitMs) {
    let results: ServiceProvider[] = [];
    try {
      results = await buyerBazaar.discover({ capability: CAPABILITY, limit: 10 });
    } catch (err) {
      if (err instanceof DegradedDiscoveryError) {
        // API degraded — fall back to RPC results
        results = (err as DegradedDiscoveryError<ServiceProvider>).rpcResults ?? [];
      }
      // other errors: let loop retry
    }

    const found = results.find((r) => r.listing.toBase58() === listingPubkey);
    if (found) {
      spinner.stop(`${c.green('✓')} Indexer caught up — listing found`);
      return found;
    }

    await sleep(5_000);
  }

  spinner.stop(c.yellow('  Timed out waiting for indexer — continuing with listing PDA directly'));
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── Banner ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(c.bold(c.cyan('╔══════════════════════════════════════════════════════╗')));
  console.log(c.bold(c.cyan('║       AGENT BAZAAR — LIVE DEVNET DEMO                ║')));
  console.log(c.bold(c.cyan('╚══════════════════════════════════════════════════════╝')));
  console.log('');
  console.log(c.cyan('  This demo will run a real escrow lifecycle on Solana devnet.'));
  console.log(c.cyan('  Two AI agents will be created, fund the buyer, register a service,'));
  console.log(c.cyan('  hire, deliver, confirm, and release USDC. All on-chain.'));
  console.log('');
  await sleep(1500);

  // ── Phase 1: Setup ─────────────────────────────────────────────────────────
  section('Phase 1 — Setup & Environment Check');

  const pinataJwt = process.env.PINATA_JWT ?? '';
  if (!pinataJwt) {
    console.error(c.red('  ERROR: PINATA_JWT env var is required for metadata upload.'));
    console.error('  Set it in your shell or in the repo root .env file.');
    process.exit(1);
  }

  const rpcUrl =
    process.env.SOLANA_RPC_URL ??
    (process.env.HELIUS_API_KEY
      ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : 'https://api.devnet.solana.com');

  info(`RPC endpoint: ${c.dim(rpcUrl.replace(/api-key=[^&]+/, 'api-key=***'))}`);

  const connection = new Connection(rpcUrl, 'confirmed');
  const master = loadMasterKeypair();

  info(`Master wallet: ${c.yellow(master.publicKey.toBase58())}`);

  // Check master balances
  const spin1 = makeSpinner('Checking master wallet balances');
  const masterSol = await connection.getBalance(master.publicKey);
  const masterUsdc = await getUsdcBalance(connection, master.publicKey);
  spin1.stop(`${c.green('✓')} Master wallet verified`);

  info(`Master SOL: ${c.yellow((masterSol / LAMPORTS_PER_SOL).toFixed(4))} SOL`);
  info(`Master USDC: ${c.yellow(microToDisplay(masterUsdc))}`);

  if (masterSol < MIN_MASTER_SOL) {
    console.error(
      c.red(
        `\n  ERROR: Master wallet has insufficient SOL (${(masterSol / LAMPORTS_PER_SOL).toFixed(4)} < 0.15)`,
      ),
    );
    console.error('  Faucet: https://faucet.solana.com');
    process.exit(1);
  }
  if (masterUsdc < MIN_MASTER_USDC_MICRO) {
    console.error(
      c.red(
        `\n  ERROR: Master wallet has insufficient USDC (${microToDisplay(masterUsdc)} < $2.00)`,
      ),
    );
    console.error('  Faucet: https://faucet.circle.com (select "Devnet")');
    process.exit(1);
  }

  await sleep(1000);

  // ── Phase 2: Generate agent keypairs ────────────────────────────────────────
  section('Phase 2 — Generate Agent Keypairs');

  const providerKeypair = Keypair.generate();
  const buyerKeypair = Keypair.generate();

  info(`Provider Agent: ${c.yellow(providerKeypair.publicKey.toBase58())}`);
  info(`Buyer Agent:    ${c.yellow(buyerKeypair.publicKey.toBase58())}`);
  await sleep(800);

  // Fund SOL
  const spin2a = makeSpinner('Funding both agents with SOL from master');
  await fundSol(connection, master, providerKeypair.publicKey, SOL_FUND);
  await fundSol(connection, master, buyerKeypair.publicKey, SOL_FUND);
  spin2a.stop(`${c.green('✓')} SOL funded`);

  // Fund USDC to buyer
  const spin2b = makeSpinner('Funding buyer with 1.50 USDC from master');
  await fundUsdc(connection, master, buyerKeypair.publicKey, BUYER_FUND_MICRO);
  // Create provider ATA (0 USDC) so it's ready to receive on confirm
  await fundUsdc(connection, master, providerKeypair.publicKey, 0n);
  spin2b.stop(`${c.green('✓')} USDC funded`);

  const providerSol = await connection.getBalance(providerKeypair.publicKey);
  const buyerUsdc = await getUsdcBalance(connection, buyerKeypair.publicKey);

  ok(`Provider SOL: ${(providerSol / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  ok(`Buyer USDC:   ${microToDisplay(buyerUsdc)}`);
  await sleep(1500);

  // ── Phase 3: Provider registers service ───────────────────────────────────
  section('Phase 3 — Provider Registers Service');
  console.log(c.cyan('  Provider is registering "Translate Text" service:'));
  console.log(c.cyan('    Price: $0.10/job  |  Max latency: 5 000 ms  |  Uptime SLA: 99.5%'));

  const providerWallet = await makeKeypairWallet(providerKeypair);
  const providerBazaar = new AgentBazaar({
    wallet: providerWallet,
    rpc: connection,
    pinataJwt,
    discoveryApiUrl: DISCOVERY_API_URL,
  });

  await sleep(800);
  const spin3 = makeSpinner('Submitting register_service transaction');

  let listingPubkey: string;
  let registerSig: string;
  try {
    const result = await providerBazaar.register({
      name: 'Translate Text (Demo)',
      description: 'AI-powered text translation service. Supports 50+ language pairs.',
      capability: CAPABILITY,
      priceUsdc: 100_000n, // $0.10
      pricingModel: 'per_job',
      sla: {
        maxLatencyMs: 5_000,
        minUptimePct: 9950, // 99.50%
        responseFormat: 'json',
      },
      endpoint: 'https://translate-demo.agentbazaar.local/api',
    });
    listingPubkey = result.listing.toBase58();
    registerSig = result.signature;
    spin3.stop(`${c.green('✓')} Service registered`);
  } catch (err) {
    spin3.stop(c.red('  ✗ Registration failed'));
    console.error(c.red(`  ERROR: ${(err as Error).message}`));
    process.exit(1);
  }

  ok(`Listing PDA: ${c.yellow(listingPubkey)}`);
  info(`  ${explorerAccount(listingPubkey)}`);
  ok(`Tx: ${c.yellow(registerSig)}`);
  info(`  ${explorerTx(registerSig)}`);
  await sleep(1500);

  // ── Phase 4: Buyer discovers service ─────────────────────────────────────
  section('Phase 4 — Buyer Discovers Service');
  console.log(c.cyan('  Buyer is searching for translation services via Discovery API...'));
  console.log(c.cyan(`  Capability filter: "${CAPABILITY}"`));

  const buyerWallet = await makeKeypairWallet(buyerKeypair);
  const buyerBazaar = new AgentBazaar({
    wallet: buyerWallet,
    rpc: connection,
    pinataJwt: '',
    discoveryApiUrl: DISCOVERY_API_URL,
  });

  await sleep(800);

  const discoveredService = await discoverWithRetry(buyerBazaar, listingPubkey);

  if (discoveredService) {
    ok(`Found ${c.yellow('1')} matching service`);
    ok(`Listing: ${c.yellow(discoveredService.listing.toBase58().slice(0, 16))}...`);
    ok(`Price: ${c.yellow(microToDisplay(discoveredService.priceUsdc))}/job`);
    ok(`Reputation: ${c.yellow(String(discoveredService.reputation))}`);
  } else {
    // API/indexer not ready yet — proceed with the listing PDA we already know
    ok(`Proceeding with known listing PDA (indexer still catching up)`);
    info(`  Listing: ${c.yellow(listingPubkey.slice(0, 16))}...`);
  }

  await sleep(1500);

  // ── Phase 5: Buyer hires provider (escrow) ────────────────────────────────
  section('Phase 5 — Buyer Hires Provider (1.00 USDC Escrow)');
  console.log(c.cyan('  Buyer is hiring Provider with $1.00 USDC escrow, 5-min timeout...'));

  await sleep(800);
  const spin5 = makeSpinner('Submitting create_escrow transaction');

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  let hireSig: string;
  try {
    const handle = await buyerBazaar.hire(listingPubkey, {
      budget: BUDGET_MICRO,
      sla: { maxLatencyMs: 5_000 },
      timeout: 300, // 5 minutes
    });
    escrowPda = handle.escrowPda;
    vaultPda = handle.vaultPda;
    hireSig = handle.signature;
    spin5.stop(`${c.green('✓')} Escrow created`);
  } catch (err) {
    spin5.stop(c.red('  ✗ Hire failed'));
    console.error(c.red(`  ERROR: ${(err as Error).message}`));
    process.exit(1);
  }

  ok(`Escrow PDA: ${c.yellow(escrowPda.toBase58())}`);
  info(`  ${explorerAccount(escrowPda.toBase58())}`);
  ok(`Vault PDA:  ${c.yellow(vaultPda.toBase58())}`);
  ok(`Tx: ${c.yellow(hireSig)}`);
  info(`  ${explorerTx(hireSig)}`);
  ok(c.green('$1.00 USDC locked in escrow vault'));
  await sleep(1500);

  // ── Phase 6: Provider delivers ───────────────────────────────────────────
  section('Phase 6 — Provider Submits Delivery');
  console.log(c.cyan('  Provider is submitting job result to the escrow...'));

  const resultHash = new Uint8Array(randomBytes(32));
  const resultUri = `ipfs://bafyreie${Buffer.from(randomBytes(16)).toString('hex')}/result.json`;

  await sleep(800);
  const spin6 = makeSpinner('Submitting submit_delivery transaction');

  let deliverSig: string;
  try {
    deliverSig = await providerBazaar.deliver(escrowPda.toBase58(), {
      resultUri,
      resultHash,
    });
    spin6.stop(`${c.green('✓')} Delivery submitted`);
  } catch (err) {
    spin6.stop(c.red('  ✗ Delivery failed'));
    console.error(c.red(`  ERROR: ${(err as Error).message}`));
    process.exit(1);
  }

  ok(`Result URI: ${c.dim(resultUri)}`);
  ok(`Tx: ${c.yellow(deliverSig)}`);
  info(`  ${explorerTx(deliverSig)}`);
  await sleep(1500);

  // ── Phase 7: Buyer confirms ───────────────────────────────────────────────
  section('Phase 7 — Buyer Confirms Delivery');
  console.log(c.cyan('  Buyer is reviewing the delivery and releasing funds...'));

  // Snapshot provider USDC before confirm
  const providerUsdcBefore = await getUsdcBalance(connection, providerKeypair.publicKey);

  await sleep(800);
  const spin7 = makeSpinner('Submitting confirm_delivery transaction');

  let confirmSig: string;
  try {
    confirmSig = await buyerBazaar.confirm(escrowPda.toBase58(), {
      score: 95,
      tags: ['fast', 'accurate'],
    });
    spin7.stop(`${c.green('✓')} Delivery confirmed — USDC released`);
  } catch (err) {
    spin7.stop(c.red('  ✗ Confirm failed'));
    console.error(c.red(`  ERROR: ${(err as Error).message}`));
    process.exit(1);
  }

  ok(`Tx: ${c.yellow(confirmSig)}`);
  info(`  ${explorerTx(confirmSig)}`);
  ok(c.green('Vault released $1.00 USDC to Provider ATA'));
  await sleep(1500);

  // ── Phase 8: Verify reputation ───────────────────────────────────────────
  section('Phase 8 — Verify Reputation & Final Balances');

  const spin8 = makeSpinner('Reading on-chain state');

  // Load final balances
  const buyerUsdcAfter = await getUsdcBalance(connection, buyerKeypair.publicKey);
  const providerUsdcAfter = await getUsdcBalance(connection, providerKeypair.publicKey);

  // Fetch jobs_completed from listing account
  let jobsCompleted = 0;
  try {
    const { BazaarRegistryIDL } = await import('@agentbazaar/idl');
    const { AnchorProvider, Program } = await import('@coral-xyz/anchor');
    // biome-ignore lint/suspicious/noExplicitAny: noop wallet used for read-only RPC queries; Anchor generics require any
    const noopWallet: any = {
      publicKey: PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    };
    const provider = new AnchorProvider(connection, noopWallet, { commitment: 'confirmed' });
    // biome-ignore lint/suspicious/noExplicitAny: Anchor Program generics require any for dynamic IDL usage
    const prog = new Program(BazaarRegistryIDL as any, provider);
    // biome-ignore lint/suspicious/noExplicitAny: prog.account is dynamically typed by Anchor
    const listing = await (prog.account as any).serviceListing.fetch(new PublicKey(listingPubkey));
    jobsCompleted = listing.jobsCompleted as number;
  } catch {
    // non-critical
  }

  spin8.stop(`${c.green('✓')} On-chain state verified`);

  if (jobsCompleted > 0) {
    ok(`Provider jobs_completed: ${c.yellow(String(jobsCompleted))}`);
  }
  ok(
    `Provider USDC after: ${c.yellow(microToDisplay(providerUsdcAfter))} (received ${c.green(microToDisplay(providerUsdcAfter - providerUsdcBefore))})`,
  );
  ok(
    `Buyer USDC after:    ${c.yellow(microToDisplay(buyerUsdcAfter))} (was ${c.yellow(microToDisplay(BUYER_FUND_MICRO))})`,
  );

  await sleep(1500);

  // ── Final summary box ─────────────────────────────────────────────────────
  const box = [
    '╔═══════════════════════════════════════════════════════════════╗',
    '║   DEMO COMPLETE — verify on Solana Explorer:                  ║',
    '╠═══════════════════════════════════════════════════════════════╣',
    `║  Listing:     https://explorer.solana.com/address/            ║`,
    `║               ${listingPubkey.slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║  Escrow:      https://explorer.solana.com/address/            ║`,
    `║               ${escrowPda.toBase58().slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║  Register tx: https://explorer.solana.com/tx/                 ║`,
    `║               ${registerSig.slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║  Hire tx:     https://explorer.solana.com/tx/                 ║`,
    `║               ${hireSig.slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║  Delivery tx: https://explorer.solana.com/tx/                 ║`,
    `║               ${deliverSig.slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║  Confirm tx:  https://explorer.solana.com/tx/                 ║`,
    `║               ${confirmSig.slice(0, 44)}  ║`,
    `║               ?cluster=devnet                                 ║`,
    `║                                                               ║`,
    `║  Provider USDC: ${microToDisplay(providerUsdcAfter).padEnd(10)} (received ${microToDisplay(providerUsdcAfter - providerUsdcBefore).padEnd(5)})         ║`,
    `║  Buyer USDC:    ${microToDisplay(buyerUsdcAfter).padEnd(10)} (was ${microToDisplay(BUYER_FUND_MICRO).padEnd(5)})              ║`,
    `║  Jobs completed: ${String(jobsCompleted).padEnd(5)}                                      ║`,
    '╚═══════════════════════════════════════════════════════════════╝',
  ];

  console.log('');
  for (const line of box) {
    console.log(c.bold(c.green(line)));
    await sleep(40);
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error(c.red('\n  FATAL ERROR:'), (err as Error).message ?? String(err));
  process.exit(1);
});
