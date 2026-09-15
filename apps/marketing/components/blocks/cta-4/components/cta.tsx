import { Badge } from "@/components/reui/badge"
import { Frame, FramePanel } from "@/components/reui/frame"

import { Button } from "@/components/ui/button"
import { Item, ItemMedia } from "@/components/ui/item"
import { LayoutGridIcon, PuzzleIcon, PaletteIcon, ArrowRightIcon } from "lucide-react"

const PROOF = [
  {
    title: "900+ Blocks",
    description: "Registry-ready sections for every surface you ship.",
    icon: (
      <LayoutGridIcon aria-hidden="true" />
    ),
  },
  {
    title: "shadcn Compatible",
    description: "Drop-in primitives that match your existing stack.",
    icon: (
      <PuzzleIcon aria-hidden="true" />
    ),
  },
  {
    title: "Theme-Aware",
    description: "Source code that adapts to your design tokens.",
    icon: (
      <PaletteIcon aria-hidden="true" />
    ),
  },
] as const

export function Cta() {
  return (
    <section
      aria-labelledby="cta-4-title"
      className="flex w-full max-w-4xl flex-col gap-10 lg:gap-12"
    >
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 text-center">
        <Badge variant="secondary" size="lg" className="w-fit">
          ReUI Pro
        </Badge>
        <h2
          id="cta-4-title"
          className="text-foreground text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl"
        >
          Ship Finished Interfaces
        </h2>
        <p className="text-muted-foreground max-w-xl text-base leading-7 text-pretty sm:text-lg sm:leading-8">
          Drop production-grade ReUI sections into your product and ship a
          finished-looking interface without a redesign pass.
        </p>
      </div>

      <Frame className="w-full">
        <div className="grid gap-1 md:grid-cols-3">
          {PROOF.map((point) => (
            <FramePanel key={point.title} className="flex flex-col gap-4">
              <Item className="border-background bg-muted [&_svg]:text-accent-foreground flex size-10.5 items-center justify-center border-2 p-0 shadow-[0_1px_3px_0_rgba(0,0,0,0.14)] dark:border [&_svg]:size-5">
                <ItemMedia variant="icon" className="size-auto">
                  {point.icon}
                </ItemMedia>
              </Item>
              <div className="flex flex-col gap-1.5">
                <h3 className="text-foreground text-base font-semibold tracking-tight">
                  {point.title}
                </h3>
                <p className="text-muted-foreground text-sm leading-6 text-pretty">
                  {point.description}
                </p>
              </div>
            </FramePanel>
          ))}
        </div>
      </Frame>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button nativeButton={false} render={<a href="#" />} size="lg">
          Browse Blocks
          <ArrowRightIcon aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href="#" />}
          size="lg"
        >
          View Documentation
        </Button>
      </div>
    </section>
  )
}