import { ArrowRightIcon } from "lucide-react"

import { SiteLink } from "@/components/site/site-link"
import { site } from "@/lib/site"
import { Button } from "@permdock/ui/components/button"
import { Card } from "@permdock/ui/components/card"

export function Cta() {
  return (
    <Card className="relative isolate w-full overflow-hidden border-0 p-0">
      {/* Aurora background: a deep base with a blue glow blooming to a bright bottom edge */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 130% at 60% 128%, oklch(0.97 0.03 255) 0%, oklch(0.64 0.24 258) 22%, oklch(0.4 0.17 261) 46%, oklch(0.2 0.07 263) 66%, transparent 82%), radial-gradient(85% 75% at 20% 116%, oklch(0.5 0.21 262) 0%, transparent 56%), oklch(0.13 0.025 264)",
        }}
      />

      <div className="relative flex flex-col items-center gap-8 px-6 py-20 text-center sm:px-10 sm:py-28">
        <div className="flex max-w-2xl flex-col items-center gap-4">
          <h2 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-[oklch(0.98_0.012_255)] sm:text-5xl">
            Ship the check with the feature
          </h2>
          <p className="text-base leading-7 text-[oklch(0.86_0.03_258)]">
            Install the package, define the resources you already have, and put
            decide() on the route, the tool and the query.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            nativeButton={false}
            render={<SiteLink href={site.getStarted} />}
            size="lg"
            className="rounded-full bg-[oklch(0.98_0.012_255)] text-[oklch(0.2_0.03_264)] hover:bg-[oklch(0.92_0.02_255)] hover:text-[oklch(0.2_0.03_264)]"
          >
            Get started
            <ArrowRightIcon aria-hidden="true" />
          </Button>
          <Button
            nativeButton={false}
            render={<SiteLink href="/create" />}
            size="lg"
            variant="outline"
            className="rounded-full border-white/25 bg-white/10 text-[oklch(0.98_0.012_255)] hover:bg-white/20 hover:text-white"
          >
            Create a policy
          </Button>
        </div>
      </div>
    </Card>
  )
}
