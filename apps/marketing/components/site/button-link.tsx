import { buttonVariants } from '@permdock/ui/components/button';
import { cn } from '@permdock/ui/lib/utils';

import { SiteLink, type SiteLinkProps } from './site-link';

type ButtonVariants = NonNullable<Parameters<typeof buttonVariants>[0]>;

export type ButtonLinkProps = SiteLinkProps &
  Pick<ButtonVariants, 'variant' | 'size'>;

/** A link styled as a button. Renders on the server; `Button` is for actions. */
export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <SiteLink
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
