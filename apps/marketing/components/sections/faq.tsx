'use client';

import { CircleHelpIcon, LifeBuoyIcon, MailIcon } from 'lucide-react';

import { Badge } from '@/components/reui/badge';
import { SiteLink } from '@/components/site/site-link';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { faqItems } from '@/lib/faq';
import { site } from '@/lib/site';

export function FaqSection() {
  const first = faqItems[0];
  const defaultValue =
    first === undefined
      ? []
      : [first.question.toLowerCase().replaceAll(' ', '-')];

  return (
    <section
      id="faq"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-16 md:px-8"
    >
      <div className="flex max-w-2xl flex-col gap-3">
        <Badge variant="primary-light" className="gap-1.5">
          <CircleHelpIcon aria-hidden="true" />
          FAQ
        </Badge>
        <h2 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
          Before you adopt
        </h2>
        <p className="text-muted-foreground max-w-md text-base">
          Licensing, network, fail-closed, and where authentication lives.
        </p>
      </div>
      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,0.85fr)]">
        <Card className="p-0">
          <CardContent className="px-6 py-2">
            <Accordion multiple={false} defaultValue={defaultValue}>
              {faqItems.map((item) => {
                const id = item.question.toLowerCase().replaceAll(' ', '-');
                return (
                  <AccordionItem
                    key={id}
                    value={id}
                    className="border-border/60 border-b last:border-b-0"
                  >
                    <AccordionTrigger className="items-start gap-4 py-4 text-left text-base font-medium hover:no-underline [&>svg]:my-auto">
                      <span className="min-w-0 text-pretty">
                        {item.question}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground pb-4 text-sm leading-6">
                      <p>{item.answer}</p>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </CardContent>
        </Card>
        <aside className="lg:sticky lg:top-20">
          <Card className="bg-muted/40 gap-4 border-dashed p-6 shadow-none">
            <CardContent className="flex flex-col gap-4 p-0">
              <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
                <LifeBuoyIcon aria-hidden="true" />
              </span>
              <p className="text-base font-semibold">Still have questions?</p>
              <p className="text-muted-foreground text-sm leading-6">
                Read the threat model, or email us. No invented SLA.
              </p>
              <Button
                nativeButton={false}
                render={<SiteLink href="/docs/security/threat-model" />}
                className="w-full"
              >
                Threat model
              </Button>
              <div className="border-border/60 flex items-center gap-2.5 border-t pt-4 text-sm">
                <MailIcon
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
                <a
                  href={`mailto:${site.email}`}
                  className="font-medium underline-offset-3 hover:underline"
                >
                  {site.email}
                </a>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </section>
  );
}
