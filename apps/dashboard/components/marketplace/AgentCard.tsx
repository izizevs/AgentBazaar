'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { CheckCircle } from 'lucide-react';
import Link from 'next/link';
import type { Listing } from '../../lib/api';
import { pricingLabel, satiHandle, toUsdc } from '../../lib/api';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Card, CardContent } from '../ui/Card';
import { Pill } from '../ui/Pill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/Tooltip';

interface AgentCardProps {
  listing: Listing;
}

export function AgentCard({ listing }: AgentCardProps) {
  const { connected } = useWallet();
  const handle = listing.satiHandle ?? satiHandle(listing.owner);
  const price = toUsdc(listing.priceUsdc);
  const rep = listing.reputation ?? 0;
  const latencyMs = listing.sla.maxLatencyMs;
  const uptime = listing.sla.minUptimePct;
  const format = listing.sla.responseFormat ?? 'text';

  const hireButton = connected ? (
    <Link href={`/escrow/create?listing=${listing.pubkey}`}>
      <Button variant="secondary" size="sm" className="ml-auto flex-shrink-0">
        Hire
      </Button>
    </Link>
  ) : (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="secondary" size="sm" className="ml-auto flex-shrink-0" disabled>
              Hire
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Connect wallet to hire</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <Card className="flex flex-col hover:shadow-md transition-shadow">
      <CardContent className="flex flex-col gap-3 pt-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Link href={`/agent/${listing.pubkey}`}>
            <Avatar seed={listing.pubkey} size={44} />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <Link
                href={`/agent/${listing.pubkey}`}
                className="font-semibold text-sm hover:underline truncate"
              >
                {listing.name}
              </Link>
              <CheckCircle className="h-3.5 w-3.5 text-primary flex-shrink-0" />
            </div>
            <p className="text-xs text-muted font-mono truncate">{handle}</p>
          </div>
          {/* Reputation badge */}
          <div className="flex-shrink-0 h-9 w-9 rounded-full bg-badgeBg flex items-center justify-center text-primary font-semibold text-sm">
            {rep}
          </div>
        </div>

        {/* Capability pill */}
        <div>
          <Pill variant="default">{listing.capability}</Pill>
        </div>

        {/* Description */}
        <p className="text-sm text-muted line-clamp-3">
          {listing.description || 'No description provided.'}
        </p>

        {/* SLA pills */}
        <div className="flex flex-wrap gap-1.5">
          {latencyMs !== undefined && (
            <Pill variant="mono">
              <span className="font-semibold text-foreground">
                {latencyMs >= 1000 ? `${latencyMs / 1000}s` : `${latencyMs}ms`}
              </span>{' '}
              latency
            </Pill>
          )}
          {uptime !== undefined && (
            <Pill variant="mono">
              <span className="font-semibold text-foreground">{uptime}%</span> uptime
            </Pill>
          )}
          <Pill variant="mono">{format}</Pill>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 mt-auto">
          <div>
            <span className="font-semibold text-base">${price.toFixed(2)}</span>
            <span className="text-muted text-xs">{pricingLabel(listing.pricingModel)}</span>
            <p className="text-xs text-muted mt-0.5">
              {listing.jobsCompleted.toLocaleString()} jobs
              {' · '}
              {listing.sla.minUptimePct !== undefined
                ? `${listing.sla.minUptimePct}% SLA pass`
                : 'SLA n/a'}
            </p>
          </div>
          {hireButton}
        </div>
      </CardContent>
    </Card>
  );
}
