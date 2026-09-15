"use client"

/**
 * Marketing hero on a blueprint frame: an announcement badge, a headline, a
 * keyword-emphasized lede, and a primary/secondary action pair, seated low in a
 * tall bordered frame above a three-cell feature grid that shares its hairlines.
 * The grid walks its own highlight, so the cells read as live unattended.
 * customize: copy and actions here; the feature links live in data.tsx.
 */
import { useEffect, useState } from "react"
import { Badge } from "@/components/reui/badge"
import { IconTile } from "@/components/reui/icon-tile"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { HERO_FEATURES } from "./data"
import { ArrowUpRightIcon, Share2Icon, LayoutGridIcon, ArrowRightIcon } from "lucide-react"

/* How long a cell holds before the highlight moves on; 0 stops the walk. Short,
   because the walk only moves a highlight: no panel swaps under it. */
const CELL_DWELL_MS = 2200

export function Hero() {
  const [activeTitle, setActiveTitle] = useState(HERO_FEATURES[0].title)
  /* Held while a reader is on the grid, pointer or keyboard, so the highlight
     never moves out from under them mid-sentence. */
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (held || CELL_DWELL_MS <= 0) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const timer = setTimeout(() => {
      setActiveTitle((current) => {
        const index = HERO_FEATURES.findIndex(
          (feature) => feature.title === current
        )
        return HERO_FEATURES[(index + 1) % HERO_FEATURES.length].title
      })
    }, CELL_DWELL_MS)

    return () => clearTimeout(timer)
  }, [activeTitle, held])

  return (
    <section
      aria-labelledby="hero-15-title"
      className="bg-background flex min-h-svh w-full items-center px-4 py-12 sm:px-6 lg:px-20"
    >
      {/* `rounded-xl` is the shadcn Card radius; the clip goes with it because
          the feature cells paint their own background into the bottom corners. */}
      <div className="border-border mx-auto w-full max-w-7xl overflow-hidden rounded-xl border">
        {/* Content sits low in a tall frame, the drawing-guide margin that gives
            the hero its blueprint feel. */}
        <div className="flex flex-col items-start gap-4 px-6 pt-16 pb-6 sm:pt-24 lg:pt-32">
          <Badge
            variant="outline"
            radius="full"
            render={<a href="#" />}
            className="text-foreground hover:bg-accent h-7 gap-1.5 px-2 text-sm font-medium transition-colors"
          >
            <span
              aria-hidden="true"
              className="bg-success size-1.5 shrink-0 rounded-full"
            />
            ReUI Pro is LIVE!
            <ArrowUpRightIcon aria-hidden="true" className="text-muted-foreground size-3.5" />
          </Badge>

          <h1
            id="hero-15-title"
            className="text-foreground max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl lg:leading-[1.05]"
          >
            Build better shadcn/ui products from design to production.
          </h1>

          <p className="text-muted-foreground max-w-3xl text-base leading-6">
            A design-led{" "}
            <span className="text-foreground font-medium">shadcn/ui</span>{" "}
            platform with production-ready blocks,{" "}
            <span className="text-foreground font-medium">MCP tools</span>,
            reusable patterns, and a curated registry for moving from first
            draft to polished product with less repetition, stronger
            consistency, and{" "}
            <span className="text-foreground font-medium">faster delivery</span>
            .
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button nativeButton={false} render={<a href="#" />}>
              <Share2Icon aria-hidden="true" className="size-4" />
              Connect MCP
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href="#" />}
            >
              <LayoutGridIcon aria-hidden="true" className="size-4" />
              Browse Registry
            </Button>
          </div>
        </div>

        {/* Feature grid. A 1px gap over a border-colored sheet draws exact
            hairline rules between cells at every breakpoint. */}
        <div
          className="bg-border border-border group/grid grid grid-cols-1 gap-px border-t lg:grid-cols-3"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocusCapture={() => setHeld(true)}
          onBlurCapture={() => setHeld(false)}
        >
          {HERO_FEATURES.map((feature) => {
            const isActive = feature.title === activeTitle

            return (
              <a
                key={feature.title}
                href={feature.href}
                onClick={() => setActiveTitle(feature.title)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "group/feature bg-background hover:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 flex items-start gap-2.5 p-6 transition-colors outline-none focus-visible:ring-[3px]",
                  // Hover wins while the pointer is inside, so the walk never
                  // fights the cell a reader is actually pointing at.
                  isActive && "group-not-has-[a:hover]/grid:bg-muted"
                )}
              >
                {/* `outline` carries the border and the 32px/16px sizing; the
                    design fills it with `muted`. On the live cell the fill swaps
                    to the page surface, so the tile stays read against the cell. */}
                <IconTile
                  variant="outline"
                  size="sm"
                  className={cn(
                    "bg-muted dark:bg-muted transition-colors",
                    "group-hover/feature:bg-background dark:group-hover/feature:bg-background",
                    isActive &&
                      "group-not-has-[a:hover]/grid:bg-background dark:group-not-has-[a:hover]/grid:bg-background"
                  )}
                >
                  {feature.icon}
                </IconTile>
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-foreground text-sm font-medium">
                    {feature.title}
                  </p>
                  <p className="text-muted-foreground line-clamp-3 text-sm">
                    {feature.description}
                  </p>
                </div>
                <ArrowRightIcon aria-hidden="true" className={cn(
                                        "text-muted-foreground size-4 shrink-0 self-center transition-transform group-hover/feature:translate-x-0.5",
                                        isActive && "group-not-has-[a:hover]/grid:translate-x-0.5"
                                      )} />
              </a>
            )
          })}
        </div>
      </div>
    </section>
  )
}