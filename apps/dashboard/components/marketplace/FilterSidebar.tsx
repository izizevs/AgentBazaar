'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Slider } from '../ui/Slider';
import { cn } from '../ui/utils';

const CATEGORIES = ['All', 'DeFi', 'Data', 'Content', 'Security', 'Research'];

export interface FilterState {
  category: string;
  maxPrice: number;
  minReputation: number;
  maxLatency: string;
  chain: string;
}

interface FilterSidebarProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

export function FilterSidebar({ filters, onChange }: FilterSidebarProps) {
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <aside className="w-64 flex-shrink-0 space-y-7">
      {/* Category */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Category</p>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => set('category', cat)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                filters.category === cat
                  ? 'border-foreground bg-foreground text-white'
                  : 'border-border bg-card hover:border-foreground',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Max Price */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">
            Max Price (USDC)
          </p>
        </div>
        <Slider
          min={0}
          max={1500}
          step={10}
          value={[filters.maxPrice]}
          onValueChange={([v]) => set('maxPrice', v ?? 1500)}
          className="mb-3"
        />
        <div className="flex justify-between text-xs text-muted">
          <span>$0.50</span>
          <span>≤ ${filters.maxPrice.toLocaleString()}</span>
        </div>
      </div>

      {/* Min Reputation */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">
            Min Reputation
          </p>
        </div>
        <Slider
          min={0}
          max={100}
          step={1}
          value={[filters.minReputation]}
          onValueChange={([v]) => set('minReputation', v ?? 0)}
          className="mb-3"
        />
        <div className="flex justify-between text-xs text-muted">
          <span>{filters.minReputation}</span>
          <span>≥ {filters.minReputation}</span>
        </div>
      </div>

      {/* Max Latency SLA */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
          Max Latency SLA
        </p>
        <Select value={filters.maxLatency} onValueChange={(v) => set('maxLatency', v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Any" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="500">≤ 500ms</SelectItem>
            <SelectItem value="1000">≤ 1s</SelectItem>
            <SelectItem value="5000">≤ 5s</SelectItem>
            <SelectItem value="15000">≤ 15s</SelectItem>
            <SelectItem value="60000">≤ 60s</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Chain */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Chain</p>
        <div className="flex flex-wrap gap-2">
          {['Solana'].map((chain) => (
            <button
              key={chain}
              type="button"
              onClick={() => set('chain', chain)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                filters.chain === chain
                  ? 'border-foreground bg-foreground text-white'
                  : 'border-border bg-card hover:border-foreground',
              )}
            >
              {chain}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
