'use client';

import type { Listing } from '../../lib/api';
import { pricingLabel, satiHandle, toUsdc } from '../../lib/api';
import { Avatar } from '../ui/Avatar';

interface EscrowState {
  selectedListing: Listing | null;
  serviceIndex: number;
  quantity: number;
  slaLatency: number;
  slaUptime: number;
  slaFormat: string;
  timeout: string;
  insurance: boolean;
}

interface Step1Props {
  listings: Listing[];
  state: EscrowState;
  onChange: (updates: Partial<EscrowState>) => void;
}

export function Step1Service({ listings, state, onChange }: Step1Props) {
  const listing = state.selectedListing;
  if (!listing) {
    return (
      <div className="py-8 text-center text-muted">
        <p>No listing selected.</p>
      </div>
    );
  }

  const price = toUsdc(listing.priceUsdc);
  const subtotal = price * state.quantity;
  const handle = listing.satiHandle ?? satiHandle(listing.owner);

  return (
    <div className="space-y-6">
      {/* Agent preview card */}
      <div className="rounded-xl border border-border p-4 flex items-center gap-4">
        <Avatar seed={listing.pubkey} size={56} />
        <div className="flex-1">
          <p className="font-semibold">{listing.name}</p>
          <p className="text-sm text-muted font-mono">
            {handle} · rep {listing.reputation}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold">
            ${price.toFixed(2)}
            <span className="font-normal text-muted text-xs">
              {pricingLabel(listing.pricingModel)}
            </span>
          </p>
        </div>
      </div>

      {/* Service select */}
      <div>
        <label className="block mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
          Service
        </label>
        {listings.length > 1 ? (
          <select
            className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={state.serviceIndex}
            onChange={(e) => onChange({ serviceIndex: Number(e.target.value) })}
          >
            {listings.map((svc, i) => (
              <option key={svc.pubkey} value={i}>
                {svc.name} — ${toUsdc(svc.priceUsdc).toFixed(2)}
                {pricingLabel(svc.pricingModel)}
              </option>
            ))}
          </select>
        ) : (
          <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm flex justify-between">
            <span>
              {listing.name} — ${price.toFixed(2)}
              {pricingLabel(listing.pricingModel)}
            </span>
            <span className="text-muted">▾</span>
          </div>
        )}
      </div>

      {/* Quantity */}
      <div>
        <label className="block mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
          Quantity
        </label>
        <input
          type="number"
          min={1}
          max={100}
          value={state.quantity}
          onChange={(e) => onChange({ quantity: Math.max(1, Number(e.target.value)) })}
          className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* Subtotal */}
      <p className="text-sm text-muted">
        Subtotal <span className="text-foreground font-medium">· ${subtotal.toFixed(2)}</span>
      </p>
    </div>
  );
}

export type { EscrowState };
