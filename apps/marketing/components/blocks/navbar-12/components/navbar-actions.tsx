'use client';

import { ThemeToggle } from '@/components/site/theme-toggle';
import { Button } from '@/components/ui/button';
import { site } from '@/lib/site';
import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';

export function NavbarActions() {
  return (
    <div className="flex items-center gap-2">
      <ThemeToggle />
      <Button
        variant="ghost"
        nativeButton={false}
        render={<Link href={site.github} />}
      >
        GitHub
      </Button>
      <Button
        className="group/sliding relative overflow-hidden px-6"
        nativeButton={false}
        render={<Link href={site.getStarted} />}
      >
        <span className="inline-flex items-center transition-transform duration-300 group-hover/sliding:-translate-x-2">
          Get started
        </span>
        <ArrowRightIcon
          aria-hidden="true"
          className="absolute right-2.5 translate-x-8 opacity-0 transition-all duration-300 group-hover/sliding:translate-x-0 group-hover/sliding:opacity-100"
        />
      </Button>
    </div>
  );
}
