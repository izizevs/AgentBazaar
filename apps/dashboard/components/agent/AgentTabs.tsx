'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useWallet } from '@solana/wallet-adapter-react';
import Link from 'next/link';
import type { Listing, ReputationEntry } from '../../lib/api';
import { pricingLabel, toUsdc } from '../../lib/api';
import { Button } from '../ui/Button';
import { Pill } from '../ui/Pill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/Tooltip';
import { cn } from '../ui/utils';

interface AgentTabsProps {
  listing: Listing;
  services: Listing[];
  reputation: ReputationEntry[];
}

export function AgentTabs({ listing, services, reputation }: AgentTabsProps) {
  const { connected } = useWallet();

  return (
    <TabsPrimitive.Root defaultValue="services">
      <TabsPrimitive.List className="flex border-b border-border gap-6 -mb-px">
        {[
          { value: 'services', label: 'Services', count: services.length },
          { value: 'reputation', label: 'Reputation', count: reputation.length },
          { value: 'sla-history', label: 'SLA History', count: null },
          { value: 'transactions', label: 'Transactions', count: null },
        ].map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              'pb-3 text-sm font-medium text-muted border-b-2 border-transparent transition-colors',
              'data-[state=active]:text-foreground data-[state=active]:border-foreground',
              'hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count !== null && <span className="ml-1.5 text-xs text-muted">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      {/* Services tab */}
      <TabsPrimitive.Content value="services" className="mt-6 space-y-4">
        {services.length === 0 ? (
          <ServiceRow listing={listing} connected={connected} />
        ) : (
          services.map((svc) => <ServiceRow key={svc.pubkey} listing={svc} connected={connected} />)
        )}
      </TabsPrimitive.Content>

      {/* Reputation tab */}
      <TabsPrimitive.Content value="reputation" className="mt-6">
        {reputation.length === 0 ? (
          <p className="text-sm text-muted">No reputation history yet.</p>
        ) : (
          <div className="space-y-3">
            {reputation.slice(0, 20).map((entry, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg border border-border p-4">
                <div className="h-8 w-8 rounded-full bg-badgeBg flex items-center justify-center text-primary text-sm font-semibold">
                  {entry.score}
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap gap-1.5">
                    {entry.tags?.map((tag) => (
                      <Pill key={tag} variant="default">
                        {tag}
                      </Pill>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted font-mono">
                    {entry.buyer?.slice(0, 12)}… ·{' '}
                    {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </TabsPrimitive.Content>

      {/* SLA History tab */}
      <TabsPrimitive.Content value="sla-history" className="mt-6">
        <p className="text-sm text-muted">SLA history coming soon.</p>
      </TabsPrimitive.Content>

      {/* Transactions tab */}
      <TabsPrimitive.Content value="transactions" className="mt-6">
        <p className="text-sm text-muted">Transaction history coming soon.</p>
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

function ServiceRow({ listing, connected }: { listing: Listing; connected: boolean }) {
  const price = toUsdc(listing.priceUsdc);
  const latencyMs = listing.sla.maxLatencyMs;
  const uptime = listing.sla.minUptimePct;
  const format = listing.sla.responseFormat ?? 'text';

  const hireButton = connected ? (
    <Link href={`/escrow/create?listing=${listing.pubkey}`}>
      <Button variant="secondary" size="sm">
        Hire
      </Button>
    </Link>
  ) : (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="secondary" size="sm" disabled>
              Hire
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Connect wallet to hire</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <div className="flex items-center gap-4 py-4 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{listing.name}</p>
        <p className="text-xs text-muted mt-0.5">
          {listing.description || 'Escrowed job with SLA enforcement'}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
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
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="font-semibold text-sm">
          ${price.toFixed(2)}
          <span className="font-normal text-muted text-xs">
            {pricingLabel(listing.pricingModel)}
          </span>
        </span>
        {hireButton}
      </div>
    </div>
  );
}
