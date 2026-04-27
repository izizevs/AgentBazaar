'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useWallet } from '@solana/wallet-adapter-react';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Button } from '../../components/ui/Button';
import { StatusPill } from '../../components/ui/Pill';
import { cn } from '../../components/ui/utils';
import { truncatePubkey } from '../../lib/api';
import { explorerAddressUrl } from '../../lib/cluster';

// Placeholder escrow type (from indexer/API in V1)
interface EscrowRow {
  pubkey: string;
  counterparty: string;
  service: string;
  amountUsdc: number;
  status: string;
  createdAt: string;
  role: 'buyer' | 'provider';
}

// In MVP, we show empty state; future versions pull from /escrows?wallet=...
function useEscrows(_wallet: string | null): {
  buyer: EscrowRow[];
  provider: EscrowRow[];
  loading: boolean;
} {
  return { buyer: [], provider: [], loading: false };
}

export default function MyEscrowsPage() {
  const { publicKey, connected } = useWallet();
  const { buyer, provider, loading } = useEscrows(publicKey?.toBase58() ?? null);

  if (!connected) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-16 text-center">
        <h1 className="font-serif text-3xl mb-3">My Escrows</h1>
        <p className="text-muted mb-6">Connect your wallet to view your escrows.</p>
        <Link href="/">
          <Button variant="outline">← Back to Marketplace</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-serif text-3xl">My Escrows</h1>
        <Link href="/">
          <Button variant="outline" size="sm">
            + New Escrow
          </Button>
        </Link>
      </div>

      <TabsPrimitive.Root defaultValue="buyer">
        <TabsPrimitive.List className="flex border-b border-border gap-6 -mb-px mb-6">
          {['buyer', 'provider'].map((tab) => (
            <TabsPrimitive.Trigger
              key={tab}
              value={tab}
              className={cn(
                'pb-3 text-sm font-medium text-muted border-b-2 border-transparent capitalize',
                'data-[state=active]:text-foreground data-[state=active]:border-foreground',
                'hover:text-foreground transition-colors',
              )}
            >
              As {tab === 'buyer' ? 'Buyer' : 'Provider'}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        {['buyer', 'provider'].map((role) => {
          const rows = role === 'buyer' ? buyer : provider;
          return (
            <TabsPrimitive.Content key={role} value={role}>
              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-14 bg-border rounded-xl animate-pulse" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="py-16 text-center">
                  <p className="text-muted text-sm">
                    No escrows {role === 'buyer' ? 'as buyer' : 'as provider'} yet.
                  </p>
                  {role === 'buyer' && (
                    <Link href="/" className="mt-3 inline-block text-primary text-sm underline">
                      Browse agents →
                    </Link>
                  )}
                </div>
              ) : (
                <EscrowTable rows={rows} />
              )}
            </TabsPrimitive.Content>
          );
        })}
      </TabsPrimitive.Root>
    </div>
  );
}

function EscrowTable({ rows }: { rows: EscrowRow[] }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-background">
            {['Counterparty', 'Service', 'Amount', 'Status', 'Created', 'Actions'].map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-widest text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.pubkey}
              className="border-b border-border last:border-0 hover:bg-background transition-colors"
            >
              <td className="px-4 py-3 font-mono text-xs">{truncatePubkey(row.counterparty)}</td>
              <td className="px-4 py-3">{row.service}</td>
              <td className="px-4 py-3 font-medium">${row.amountUsdc.toFixed(2)}</td>
              <td className="px-4 py-3">
                <StatusPill status={row.status} />
              </td>
              <td className="px-4 py-3 text-muted">
                {new Date(row.createdAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  {row.status === 'DELIVERED' && (
                    <Button size="sm" variant="secondary">
                      Confirm
                    </Button>
                  )}
                  {row.status === 'ACTIVE' && (
                    <Button size="sm" variant="outline">
                      Dispute
                    </Button>
                  )}
                  <a
                    href={explorerAddressUrl(row.pubkey)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
