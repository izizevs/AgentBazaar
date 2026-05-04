import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';

const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const PROVIDER = new PublicKey('4ffjBUhfanCbQbKcKWeEjXrcBdH8GEs6zAgLEFgKAvUd');
const RPC = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8')),
    ),
  );
  const ata = await getAssociatedTokenAddress(USDC, PROVIDER);
  console.log('ATA:', ata.toBase58());
  const info = await conn.getAccountInfo(ata);
  if (info) {
    console.log('already exists');
    return;
  }
  const ix = createAssociatedTokenAccountInstruction(
    payer.publicKey,
    ata,
    PROVIDER,
    USDC,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log('created:', sig);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
