import type * as React from 'react';
import { cn } from '../ui/utils';

interface StatTileProps {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}

export function StatTile({ label, value, valueClassName }: StatTileProps) {
  return (
    <div className="flex flex-col gap-1 py-5 px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted">{label}</p>
      <p className={cn('text-3xl font-semibold', valueClassName)}>{value}</p>
    </div>
  );
}
