import Link from 'next/link';

import { footerColumns, site } from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="border-border bg-background border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 md:grid-cols-4 md:px-8">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{site.name}</p>
          <p className="text-muted-foreground max-w-xs text-sm leading-6">
            {site.tagline}
          </p>
        </div>
        {footerColumns.map((column) => (
          <div key={column.title} className="flex flex-col gap-2">
            <p className="text-sm font-semibold">{column.title}</p>
            <ul className="flex flex-col gap-1.5">
              {column.links.map((link) => (
                <li key={`${column.title}-${link.href}`}>
                  <Link
                    href={link.href}
                    className="text-muted-foreground hover:text-foreground text-sm"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-border text-muted-foreground mx-auto flex w-full max-w-6xl justify-between border-t px-6 py-4 text-xs md:px-8">
        <span>MIT License</span>
        <span>ScaleDockHQ</span>
      </div>
    </footer>
  );
}
