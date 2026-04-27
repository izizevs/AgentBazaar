'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { CheckCircle, Copy } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { AgentTabs } from '../../../components/agent/AgentTabs';
import { StatTile } from '../../../components/agent/StatTile';
import { Avatar } from '../../../components/ui/Avatar';
import { Button } from '../../../components/ui/Button';
import { Pill } from '../../../components/ui/Pill';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/Tooltip';
import type { Listing, ReputationEntry } from '../../../lib/api';
import { fetchAgentReputation, fetchListing, satiHandle } from '../../../lib/api';

interface Props {
  params: { pubkey: string };
}

export default function AgentPage({ params }: Props) {
  const { pubkey } = params;
  const { connected } = useWallet();
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [reputation, setReputation] = React.useState<ReputationEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchListing(pubkey), fetchAgentReputation(pubkey)]).then(([l, r]) => {
      if (!cancelled) {
        setListing(l);
        setReputation(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const copySatiId = () => {
    const handle = listing?.satiHandle ?? satiHandle(pubkey);
    navigator.clipboard.writeText(handle).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="h-8 w-48 bg-border rounded animate-pulse mb-8" />
        <div className="h-32 bg-border rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <p className="text-muted">Agent not found.</p>
        <Link href="/" className="text-primary text-sm underline mt-2 block">
          ← Back to Marketplace
        </Link>
      </div>
    );
  }

  const handle = listing.satiHandle ?? satiHandle(listing.owner);
  const totalEarned =
    (listing as any).totalEarnedUsdc ?? (listing.jobsCompleted * listing.priceUsdc) / 1_000_000;
  const slaPct90d = (listing as any).slaPct90d ?? listing.sla.minUptimePct ?? 0;

  const hireButton = connected ? (
    <Link href={`/escrow/create?listing=${listing.pubkey}`}>
      <Button variant="secondary" size="lg">
        Hire this agent →
      </Button>
    </Link>
  ) : (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="secondary" size="lg" disabled>
              Hire this agent →
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Connect wallet to hire</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground transition-colors">
          Marketplace
        </Link>
        <span>/</span>
        <span className="text-foreground">{listing.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="flex items-start gap-5">
          <Avatar seed={listing.pubkey} size={80} className="rounded-2xl" />
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="font-serif text-4xl">{listing.name}</h1>
              <CheckCircle className="h-6 w-6 text-primary flex-shrink-0" />
            </div>
            <div className="flex items-center gap-3 mb-2">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-sm text-muted">Online now</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs font-mono">
                SATI · {handle}
              </span>
              <span className="text-border">·</span>
              <Pill variant="default">{listing.capability}</Pill>
            </div>
            <p className="text-sm text-muted max-w-lg">{listing.description}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 items-end flex-shrink-0">
          {hireButton}
          <Button variant="outline" size="md" onClick={copySatiId}>
            <Copy className="h-4 w-4" />
            {copied ? 'Copied!' : 'Copy SATI ID'}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 border border-border rounded-xl overflow-hidden mb-8 divide-x divide-border">
        <StatTile label="Jobs Completed" value={listing.jobsCompleted.toLocaleString()} />
        <StatTile
          label="Reputation Score"
          value={listing.reputation}
          valueClassName="text-primary"
        />
        <StatTile label="SLA Compliance (90d)" value={`${slaPct90d.toFixed(1)}%`} />
        <StatTile
          label="Total Earned"
          value={`$${totalEarned.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
        />
      </div>

      {/* Tabs */}
      <AgentTabs listing={listing} services={[listing]} reputation={reputation} />
    </div>
  );
}
