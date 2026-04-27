'use client';

import type * as React from 'react';
import { satiHandle, toUsdc } from '../../lib/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import type { EscrowState } from './Step1Service';

interface Step4Props {
  state: EscrowState;
  onChange: (updates: Partial<EscrowState>) => void;
}

const TABLE_ROWS = [
  { key: 'PROVIDER' },
  { key: 'SERVICE' },
  { key: 'QUANTITY' },
  { key: 'SLA · LATENCY' },
  { key: 'SLA · UPTIME' },
  { key: 'INSURANCE' },
  { key: 'TIMEOUT' },
  { key: 'TOTAL DEPOSIT' },
] as const;

export function Step4Review({ state, onChange }: Step4Props) {
  const listing = state.selectedListing;
  if (!listing) return null;

  const price = toUsdc(listing.priceUsdc);
  const total = price * state.quantity;
  const handle = listing.satiHandle ?? satiHandle(listing.owner);

  const values: Record<string, React.ReactNode> = {
    PROVIDER: `${listing.name} · ${handle}`,
    SERVICE: listing.name,
    QUANTITY: `${state.quantity} jobs`,
    'SLA · LATENCY': `≤ ${state.slaLatency} ms`,
    'SLA · UPTIME': `≥ ${state.slaUptime}%`,
    INSURANCE: 'Off',
    TIMEOUT: (
      <Select value={state.timeout} onValueChange={(v) => onChange({ timeout: v })}>
        <SelectTrigger className="w-32 h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="24h">24h</SelectItem>
          <SelectItem value="48h">48h</SelectItem>
          <SelectItem value="72h">72h</SelectItem>
          <SelectItem value="7d">7d</SelectItem>
        </SelectContent>
      </Select>
    ),
    'TOTAL DEPOSIT': <span className="text-xl font-semibold">${total.toFixed(2)} USDC</span>,
  };

  return (
    <div className="space-y-6">
      {/* Review table */}
      <div className="rounded-xl border border-border overflow-hidden">
        {TABLE_ROWS.map(({ key }, i) => (
          <div
            key={key}
            className={`grid grid-cols-2 gap-4 px-5 py-3.5 ${i < TABLE_ROWS.length - 1 ? 'border-b border-border' : ''}`}
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">{key}</p>
            <div className="text-sm font-mono">{values[key]}</div>
          </div>
        ))}
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-muted leading-relaxed">
        By confirming, ${total.toFixed(2)} USDC will be locked in{' '}
        <code className="font-mono bg-muted/10 px-1 py-0.5 rounded text-foreground">
          bazaar-escrow
        </code>{' '}
        until delivery is verified or the {state.timeout} timeout triggers auto-release.
      </p>
    </div>
  );
}
