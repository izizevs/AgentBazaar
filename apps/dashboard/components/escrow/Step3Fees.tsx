'use client';

import { Info } from 'lucide-react';
import { toUsdc } from '../../lib/api';
import { CIRCLE_FAUCET_URL } from '../../lib/cluster';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/Tooltip';
import type { EscrowState } from './Step1Service';

interface Step3Props {
  state: EscrowState;
  onChange: (updates: Partial<EscrowState>) => void;
  usdcBalance: number | null;
}

export function Step3Fees({ state, onChange, usdcBalance }: Step3Props) {
  const listing = state.selectedListing;
  if (!listing) return null;

  const price = toUsdc(listing.priceUsdc);
  const serviceFee = price * state.quantity;
  // Platform fee: 0% during beta (shown as such per design)
  const platformFeePct = 0;
  const platformFee = serviceFee * (platformFeePct / 100);
  const total = serviceFee + platformFee;
  const hasEnough = usdcBalance !== null && usdcBalance >= total;

  return (
    <div className="space-y-4">
      {/* Fee breakdown */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span>
              Service fee ({state.quantity} × ${price.toFixed(2)})
            </span>
            <span>${serviceFee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="flex items-center gap-1.5">
              Platform fee <span className="text-primary text-xs">(0%)</span>
              <span className="text-xs text-muted italic">Free during beta</span>
            </span>
            <span>$0.00</span>
          </div>
          <div className="border-t border-border pt-3 flex justify-between font-semibold">
            <span>Total to deposit</span>
            <span>${total.toFixed(2)} USDC</span>
          </div>
        </div>
      </div>

      {/* SLA Insurance */}
      <div className="rounded-xl border border-border p-4 flex items-start gap-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-start gap-3 w-full cursor-not-allowed opacity-60">
                <input
                  type="checkbox"
                  disabled
                  checked={state.insurance}
                  onChange={(e) => onChange({ insurance: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-border cursor-not-allowed"
                />
                <div>
                  <p className="font-medium text-sm flex items-center gap-1.5">
                    Add SLA insurance (0.75%)
                    <Info className="h-3.5 w-3.5 text-muted" />
                  </p>
                  <p className="text-xs text-muted mt-0.5">
                    Pool covers partial refunds on SLA breach without draining seller's escrow.
                    Optional.
                  </p>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Coming in V1</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Wallet balance */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-mono text-muted text-xs">Wallet balance</span>
        <span className={hasEnough ? 'text-foreground' : 'text-destructive-text font-medium'}>
          ${usdcBalance !== null ? usdcBalance.toFixed(2) : '…'} USDC
        </span>
      </div>

      {/* Insufficient balance error */}
      {!hasEnough && usdcBalance !== null && (
        <div className="rounded-lg bg-destructive border border-destructive-text/20 px-4 py-3 text-sm text-destructive-text">
          Insufficient balance.{' '}
          <a
            href={CIRCLE_FAUCET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            Add funds.
          </a>
        </div>
      )}
    </div>
  );
}
