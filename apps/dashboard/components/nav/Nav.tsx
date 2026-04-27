'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Bell, Command, Monitor, Search } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { truncatePubkey } from '../../lib/api';
import { DEVNET_USDC_MINT, SOLANA_FAUCET_URL } from '../../lib/cluster';

function UsdcBalance({ publicKey }: { publicKey: import('@solana/web3.js').PublicKey }) {
  const { connection } = useConnection();
  const [balance, setBalance] = React.useState<number | null>(null);
  const [_sol, setSol] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchBalances() {
      try {
        // Fetch SOL balance
        const lamports = await connection.getBalance(publicKey);
        if (!cancelled) setSol(lamports / LAMPORTS_PER_SOL);

        // Fetch USDC token account
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
          mint: new (await import('@solana/web3.js')).PublicKey(DEVNET_USDC_MINT),
        });
        if (!cancelled && tokenAccounts.value.length > 0) {
          const first = tokenAccounts.value[0];
          const amount: number =
            first != null ? (first.account.data.parsed.info.tokenAmount.uiAmount as number) : 0;
          setBalance(amount);
        } else if (!cancelled) {
          setBalance(0);
        }
      } catch {
        if (!cancelled) {
          setBalance(0);
          setSol(0);
        }
      }
    }

    void fetchBalances();
    const interval = setInterval(() => void fetchBalances(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connection, publicKey]);

  return <span>{balance !== null ? `${balance.toFixed(2)} USDC` : '…'}</span>;
}

export function Nav() {
  const { publicKey, connected } = useWallet();

  return (
    <>
      {/* Devnet SOL banner */}
      {connected && publicKey && <DevnetBanner publicKey={publicKey} />}
      <nav className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
              <Monitor className="h-4 w-4 text-primary" />
            </div>
            <span className="font-serif text-base font-semibold tracking-tight">Agent·Bazaar</span>
          </Link>

          {/* Search */}
          <div className="flex-1 max-w-xl">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
              <Search className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">Search agents, capabilities, SATI IDs...</span>
              <kbd className="hidden md:flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs font-mono text-muted">
                <Command className="h-2.5 w-2.5" /> K
              </kbd>
            </div>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              className="relative h-9 w-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted hover:text-foreground transition-colors"
            >
              <Bell className="h-4 w-4" />
            </button>

            {connected && publicKey ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <Monitor className="h-3 w-3 text-muted" />
                <span className="font-mono text-xs text-muted">
                  {truncatePubkey(publicKey.toBase58())}
                </span>
                <span className="text-border mx-1">·</span>
                <UsdcBalance publicKey={publicKey} />
              </div>
            ) : (
              <WalletMultiButton
                style={{
                  backgroundColor: '#7C3AED',
                  borderRadius: '0.5rem',
                  height: '36px',
                  fontSize: '14px',
                  padding: '0 16px',
                }}
              />
            )}
          </div>
        </div>
      </nav>
    </>
  );
}

function DevnetBanner({ publicKey }: { publicKey: import('@solana/web3.js').PublicKey }) {
  const { connection } = useConnection();
  const [sol, setSol] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    connection
      .getBalance(publicKey)
      .then((lamports) => {
        if (!cancelled) setSol(lamports / LAMPORTS_PER_SOL);
      })
      .catch(() => {
        if (!cancelled) setSol(0);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey]);

  if (sol === null || sol > 0.1) return null;

  return (
    <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-2 text-center text-xs text-yellow-800">
      You have no devnet SOL.{' '}
      <a
        href={SOLANA_FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline font-medium"
      >
        Get devnet SOL →
      </a>
    </div>
  );
}
