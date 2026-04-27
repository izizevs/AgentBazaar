import type * as React from 'react';
import { cn } from './utils';

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'purple' | 'green' | 'red' | 'yellow' | 'mono';
}

export const Pill: React.FC<PillProps> = ({
  className,
  variant = 'default',
  children,
  ...props
}) => {
  const variants = {
    default: 'bg-muted/10 text-foreground border border-border',
    purple: 'bg-badgeBg text-primary',
    green: 'bg-green-50 text-green-700',
    red: 'bg-destructive text-destructive-text',
    yellow: 'bg-yellow-50 text-yellow-700',
    mono: 'bg-transparent text-muted border border-border font-mono text-xs',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
};

export const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { variant: PillProps['variant']; label: string }> = {
    CREATED: { variant: 'default', label: 'Created' },
    ACTIVE: { variant: 'green', label: 'Active' },
    DELIVERED: { variant: 'purple', label: 'Delivered' },
    CONFIRMED: { variant: 'green', label: 'Confirmed' },
    TIMEOUT: { variant: 'yellow', label: 'Timeout' },
    DISPUTED: { variant: 'red', label: 'Disputed' },
    CANCELLED: { variant: 'red', label: 'Cancelled' },
  };

  const { variant, label } = map[status.toUpperCase()] ?? { variant: 'default', label: status };

  return <Pill variant={variant}>{label}</Pill>;
};
