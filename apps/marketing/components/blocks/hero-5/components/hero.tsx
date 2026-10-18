import { ArrowRightIcon, CircleCheckIcon, WandSparklesIcon } from "lucide-react"

import { InstallCopy } from "@/components/sections/install-copy"
import { SiteLink } from "@/components/site/site-link"
import { site } from "@/lib/site"
import { Button } from "@permdock/ui/components/button"
import { Separator } from "@permdock/ui/components/separator"
import { Badge } from "@permdock/ui/reui/badge"

import { HERO_ASSURANCES } from "./data"
import { HeroDotField } from "./hero-dot-field"
import { StackGrid } from "./stack-grid"

export function Hero({ version }: { version: string | undefined }) {
  return (
    <section
      id="hero"
      aria-labelledby="hero-title"
      className="dark relative flex w-full items-center overflow-hidden bg-[#090b0c] px-4 py-16 sm:px-6 lg:px-8 lg:py-20"
    >
      <HeroDotField />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-30 -left-32 size-125 rounded-full bg-white/3 blur-[100px]"
      />

      {/* Stacked, the band takes the scene's own 624 measure so the copy never
          runs a full-width line over a centred scene. */}
      <div className="relative mx-auto grid w-full max-w-[624px] grid-cols-1 items-center gap-8 lg:max-w-7xl lg:grid-cols-2">
        <div className="@container flex flex-col items-start justify-center gap-7">
          {version ? (
            <Badge
              size="xl"
              radius="full"
              render={<SiteLink href="/docs/changelog" />}
              className="h-7 border-white/10 bg-transparent text-[#fafafa] transition-colors hover:bg-white/10"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-[#00bc7d]"
              />
              permdock {version} is out
              <ArrowRightIcon aria-hidden="true" />
            </Badge>
          ) : null}

          <h1
            id="hero-title"
            className="text-4xl leading-none font-semibold tracking-tight text-balance text-[#fafafa] @xl:text-5xl"
          >
            Typed permissions for apps, APIs, databases and AI agents
          </h1>

          <p className="max-w-md text-base leading-7 text-[#a1a1a1]">
            Define a policy once in TypeScript. Check it in React, on the
            server and in agent tools; compile the same conditions to SQL and
            Postgres RLS.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              nativeButton={false}
              render={<SiteLink href={site.getStarted} />}
              className="bg-blue-600 text-white hover:bg-blue-500"
            >
              Get started
              <ArrowRightIcon aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="lg"
              nativeButton={false}
              render={<SiteLink href="/create" />}
              className="border-transparent bg-white/10 text-[#fafafa] hover:bg-white/15 hover:text-white"
            >
              <WandSparklesIcon aria-hidden="true" />
              Create a policy
            </Button>
          </div>

          <InstallCopy command={site.install} />

          <Separator className="w-full max-w-md bg-white/10" />

          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {HERO_ASSURANCES.map((assurance) => (
              <li key={assurance} className="flex items-center gap-1.5">
                <CircleCheckIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-[#00bc7d]"
                />
                <span className="text-sm leading-5 text-[#fafafa]">
                  {assurance}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* The grid is drawn on a fixed 624 x 600 canvas and scaled to whatever
            width the column resolves to, so its geometry never has to reflow. */}
        <div className="@container w-full lg:max-w-[624px] lg:justify-self-end">
          <div className="relative aspect-[624/600] w-full">
            <StackGrid className="absolute top-0 left-0 origin-top-left [transform:scale(calc(100cqw/624px))]" />
          </div>
        </div>
      </div>
    </section>
  )
}
