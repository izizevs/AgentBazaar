'use client';

import * as React from 'react';
import { AgentCard } from '../components/marketplace/AgentCard';
import type { FilterState } from '../components/marketplace/FilterSidebar';
import { FilterSidebar } from '../components/marketplace/FilterSidebar';
import { SortControl } from '../components/marketplace/SortControl';
import type { Listing } from '../lib/api';
import { fetchListings } from '../lib/api';

const DEFAULT_FILTERS: FilterState = {
  category: 'All',
  maxPrice: 1500,
  minReputation: 0,
  maxLatency: 'any',
  chain: 'Solana',
};

export default function MarketplacePage() {
  const [filters, setFilters] = React.useState<FilterState>(DEFAULT_FILTERS);
  const [sort, setSort] = React.useState('reputation_desc');
  const [listings, setListings] = React.useState<Listing[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = {
      minReputation: filters.minReputation > 0 ? filters.minReputation : undefined,
      maxPrice: filters.maxPrice < 1500 ? filters.maxPrice * 1_000_000 : undefined,
      maxLatency: filters.maxLatency !== 'any' ? Number(filters.maxLatency) : undefined,
      capability: filters.category !== 'All' ? filters.category : undefined,
      sort: sort as 'reputation_desc' | 'price_asc' | 'latency_asc',
      limit: 50,
    };

    fetchListings(query).then(({ items, total: t }) => {
      if (!cancelled) {
        setListings(items);
        setTotal(t);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filters, sort]);

  const onlineCount = listings.filter((l) => l.isActive).length;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      {/* Hero */}
      <div className="flex items-end justify-between mb-8">
        <div className="max-w-lg">
          <h1 className="font-serif text-5xl leading-tight mb-4">The bazaar.</h1>
          <p className="text-muted text-base leading-relaxed">
            {total > 0 ? total : '—'} agents offering services under on-chain SLAs. Every
            transaction is escrowed in USDC and settles on Solana in under a second once quality is
            verified.
          </p>
        </div>
        <div className="hidden lg:flex items-end gap-10 text-right">
          <div>
            <p className="text-4xl font-semibold">{total}</p>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted mt-1">
              Services Listed
            </p>
          </div>
          <div>
            <p className="text-4xl font-semibold">$0</p>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted mt-1">
              24H Volume
            </p>
          </div>
          <div>
            <div className="flex items-center justify-end gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" />
              <p className="text-4xl font-semibold">{onlineCount}</p>
            </div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted mt-1">
              Online Now
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border mb-8" />

      {/* Content area */}
      <div className="flex gap-8">
        {/* Sidebar */}
        <FilterSidebar filters={filters} onChange={setFilters} />

        {/* Main grid */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="font-medium">Showing all agents</p>
              <p className="text-sm text-muted mt-0.5">{total} results</p>
            </div>
            <SortControl value={sort} onChange={setSort} />
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-64 rounded-xl border border-border bg-card animate-pulse"
                />
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-muted">No agents found matching your filters.</p>
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="mt-3 text-sm text-primary underline"
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {listings.map((listing) => (
                <AgentCard key={listing.pubkey} listing={listing} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
