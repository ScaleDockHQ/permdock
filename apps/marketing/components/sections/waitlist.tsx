'use client';

import { ArrowRightIcon, FileTextIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { CtaGridBackground } from '@/components/blocks/cta-3/components/cta-grid-background';
import { Badge } from '@/components/reui/badge';
import { Frame, FramePanel } from '@/components/reui/frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { site } from '@/lib/site';

export function WaitlistCta() {
  const [status, setStatus] = useState<'idle' | 'ok' | 'mailto'>('idle');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = data.get('email');
    if (typeof email !== 'string') {
      return;
    }
    const response = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (response.ok) {
      setStatus('ok');
      return;
    }
    window.location.href = `mailto:${site.email}?subject=${encodeURIComponent('Cloud waitlist')}&body=${encodeURIComponent(email)}`;
    setStatus('mailto');
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-6 py-16 md:px-8">
      <Frame className="w-full">
        <FramePanel className="bg-muted/35 relative isolate overflow-hidden px-5 py-14 text-center sm:px-8 sm:py-16">
          <CtaGridBackground />
          <div className="relative mx-auto flex max-w-[42rem] flex-col items-center gap-8">
            <Badge variant="secondary" size="lg" className="gap-1.5">
              <FileTextIcon aria-hidden="true" />
              Cloud waitlist
            </Badge>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Governance when you want it
            </h2>
            <p className="text-muted-foreground max-w-[34rem] text-base leading-7">
              Join the waitlist for PermDock Cloud. The in-process defaults stay
              in the MIT package either way.
            </p>
            {status === 'ok' ? (
              <p className="text-sm font-medium">You are on the list.</p>
            ) : (
              <form
                onSubmit={onSubmit}
                className="grid w-full max-w-md gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <label htmlFor="waitlist-email" className="sr-only">
                  Work email
                </label>
                <Input
                  id="waitlist-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="team@company.com"
                  className="bg-background/90"
                />
                <Button type="submit">
                  Join waitlist
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              </form>
            )}
          </div>
        </FramePanel>
      </Frame>
    </section>
  );
}
