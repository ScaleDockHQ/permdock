import type { ComponentProps } from 'react';

import { cn } from '@permdock/ui/lib/utils';

export function ScrollRegion({
  className,
  ...props
}: ComponentProps<'section'> & { 'aria-label': string }) {
  return (
    <section
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
      className={cn('overflow-x-auto', className)}
      {...props}
    />
  );
}
