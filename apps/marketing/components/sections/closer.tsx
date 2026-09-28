import {
  ArrowRightIcon,
  BookOpenIcon,
  PuzzleIcon,
  ShieldIcon,
} from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/reui/badge';
import { Frame, FramePanel } from '@/components/reui/frame';
import { Button } from '@/components/ui/button';
import { Item, ItemMedia } from '@/components/ui/item';
import { site } from '@/lib/site';

const proof = [
  {
    title: 'MIT, in-process',
    description: 'Every decision runs in your process. No network to can().',
    icon: <ShieldIcon aria-hidden="true" />,
  },
  {
    title: 'Typed references',
    description: 'permissions.post.update, never a string key in the API.',
    icon: <PuzzleIcon aria-hidden="true" />,
  },
  {
    title: 'Docs-first',
    description: 'The product plan is the docs tree, not a slide deck.',
    icon: <BookOpenIcon aria-hidden="true" />,
  },
] as const;

export function Closer() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-16 md:px-8">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 text-center">
        <Badge variant="secondary" size="lg" className="w-fit">
          Open source
        </Badge>
        <h2 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Ship the check with the feature
        </h2>
        <p className="text-muted-foreground max-w-xl text-base leading-7">
          Install the package, define the resource you already have, and put
          decide() on the route, the tool, and the query.
        </p>
      </div>
      <Frame className="w-full">
        <div className="grid gap-1 md:grid-cols-3">
          {proof.map((point) => (
            <FramePanel key={point.title} className="flex flex-col gap-4">
              <Item className="bg-muted flex size-10 items-center justify-center p-0">
                <ItemMedia variant="icon" className="size-auto">
                  {point.icon}
                </ItemMedia>
              </Item>
              <div className="flex flex-col gap-1.5">
                <h3 className="text-base font-semibold">{point.title}</h3>
                <p className="text-muted-foreground text-sm leading-6">
                  {point.description}
                </p>
              </div>
            </FramePanel>
          ))}
        </div>
      </Frame>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          nativeButton={false}
          render={<Link href={site.getStarted} />}
          size="lg"
        >
          Get started
          <ArrowRightIcon aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={site.docs} />}
          size="lg"
        >
          View documentation
        </Button>
      </div>
    </section>
  );
}
