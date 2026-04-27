'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

interface SortControlProps {
  value: string;
  onChange: (v: string) => void;
}

export function SortControl({ value, onChange }: SortControlProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted">Sort by</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="reputation_desc">Reputation</SelectItem>
          <SelectItem value="price_asc">Price</SelectItem>
          <SelectItem value="latency_asc">Latency</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
