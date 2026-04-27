'use client';

import Image from 'next/image';
import type * as React from 'react';
import { diceBearUrl } from '../../lib/api';
import { cn } from './utils';

export interface AvatarProps {
  seed: string;
  size?: number;
  className?: string;
  alt?: string;
}

export const Avatar: React.FC<AvatarProps> = ({ seed, size = 40, className, alt = '' }) => {
  return (
    <div
      className={cn('overflow-hidden rounded-xl bg-background flex-shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Image
        src={diceBearUrl(seed)}
        alt={alt}
        width={size}
        height={size}
        unoptimized
        className="object-cover w-full h-full"
      />
    </div>
  );
};
