import { Badge } from "@/components/reui/badge"
import { Frame, FramePanel } from "@/components/reui/frame"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CtaGridBackground } from "./cta-grid-background"
import { FileTextIcon, ArrowRightIcon } from "lucide-react"

export function Cta() {
  return (
    <section aria-labelledby="cta-3-title" className="w-full max-w-5xl">
      <Frame className="w-full">
        <FramePanel className="bg-muted/35 relative isolate overflow-hidden px-5 py-14 text-center sm:px-8 sm:py-16 md:px-12 md:py-20">
          <CtaGridBackground />

          <div className="relative mx-auto flex max-w-[42rem] flex-col items-center gap-8">
            <div className="flex flex-col items-center gap-4">
              <Badge variant="secondary" size="lg" className="gap-1.5">
                <FileTextIcon aria-hidden="true" />
                Release Brief
              </Badge>

              <h2
                id="cta-3-title"
                className="text-foreground text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl md:text-5xl"
              >
                Close The Launch Gap
              </h2>

              <p className="text-muted-foreground max-w-[34rem] text-base leading-7 text-pretty sm:text-lg sm:leading-8">
                Send the surface you are shipping. We map the risky handoffs
                across pricing, checkout, and onboarding before your team
                builds.
              </p>
            </div>

            <div className="flex w-full max-w-md flex-col items-center gap-3">
              <form
                id="cta-3-waitlist"
                action="#"
                className="grid w-full gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <label htmlFor="cta-3-email" className="sr-only">
                  Work Email
                </label>
                <Input
                  id="cta-3-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="team@company.com"
                  className="bg-background/90 shadow-xs"
                />
                <Button type="submit" className="w-full sm:w-auto">
                  Request Brief
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              </form>

              <p className="text-muted-foreground text-sm leading-6">
                One focused reply. No generic audit or drip campaign.
              </p>
            </div>
          </div>
        </FramePanel>
      </Frame>
    </section>
  )
}