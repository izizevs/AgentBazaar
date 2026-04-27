'use client';

import type { EscrowState } from './Step1Service';

interface Step2Props {
  state: EscrowState;
  onChange: (updates: Partial<EscrowState>) => void;
}

export function Step2SLA({ state, onChange }: Step2Props) {
  const listing = state.selectedListing;
  const defaultLatency = listing?.sla.maxLatencyMs ?? 5000;
  const defaultUptime = listing?.sla.minUptimePct ?? 99;
  const defaultFormat = listing?.sla.responseFormat ?? 'text';

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted leading-relaxed">
        SLA terms are committed on-chain and enforced by{' '}
        <code className="font-mono text-xs bg-muted/10 px-1.5 py-0.5 rounded">bazaar-sla</code>.
        Tighten below seller defaults if you need stricter guarantees. Escrow releases only if
        actuals meet or beat your requested values.
      </p>

      <div className="rounded-xl border border-border overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-3 gap-4 px-6 py-3 bg-background border-b border-border">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">Parameter</p>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">
            Seller Default
          </p>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">
            Your Requested
          </p>
        </div>

        {/* Max response latency */}
        <div className="grid grid-cols-3 gap-4 px-6 py-5 border-b border-border">
          <div>
            <p className="font-medium text-sm">Max response latency</p>
            <p className="text-xs text-muted mt-0.5">Time from request to first byte</p>
          </div>
          <div className="text-sm">
            <span className="line-through text-muted">{defaultLatency} ms</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={100}
              value={state.slaLatency}
              onChange={(e) => onChange({ slaLatency: Number(e.target.value) })}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="text-xs text-muted">ms</span>
          </div>
        </div>

        {/* Minimum uptime */}
        <div className="grid grid-cols-3 gap-4 px-6 py-5 border-b border-border">
          <div>
            <p className="font-medium text-sm">Minimum uptime</p>
            <p className="text-xs text-muted mt-0.5">Rolling 7-day endpoint availability</p>
          </div>
          <div className="text-sm">
            <span className="line-through text-muted">{defaultUptime} %</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={state.slaUptime}
              onChange={(e) => onChange({ slaUptime: Number(e.target.value) })}
              className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="text-xs text-muted">%</span>
          </div>
        </div>

        {/* Response format */}
        <div className="grid grid-cols-3 gap-4 px-6 py-5">
          <div>
            <p className="font-medium text-sm">Response format</p>
            <p className="text-xs text-muted mt-0.5">Schema validation at delivery</p>
          </div>
          <div className="text-sm">
            <span className="line-through text-muted font-mono">{defaultFormat}</span>
          </div>
          <div>
            <span className="text-sm font-mono">{state.slaFormat}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
