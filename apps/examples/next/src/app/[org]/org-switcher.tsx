import { cn } from "cn";
import Link from "next/link";

import { organizations } from "../../lib/store.ts";

/** Rendered in the static shell with `active={null}`, so the links never wait for params. */
export function OrgSwitcher(props: { readonly active: string | null }) {
  return (
    <nav
      aria-label="Organizations"
      className="bg-muted order-last flex w-full gap-1 rounded-lg p-1 sm:order-none sm:w-auto"
    >
      {organizations.map((item) => {
        const current = item.id === props.active;
        return (
          <Link
            key={item.id}
            href={`/${item.id}`}
            prefetch
            data-switch={item.id}
            aria-current={current ? "page" : false}
            className={cn(
              "text-muted-foreground hover:text-foreground flex-1 rounded-md px-3 py-1 text-center text-sm font-medium whitespace-nowrap transition-colors sm:flex-none",
              current && "bg-background text-foreground shadow-xs",
            )}
          >
            {item.name}
          </Link>
        );
      })}
    </nav>
  );
}
