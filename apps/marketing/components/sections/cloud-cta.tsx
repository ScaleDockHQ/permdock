import { ArrowRightIcon, CloudIcon } from "lucide-react";
import Link from "next/link";

import { CtaGridBackground } from "@/components/blocks/cta-3/components/cta-grid-background";
import { ButtonLink } from "@/components/site/button-link";
import { site } from "@/lib/site";
import { Badge } from "@permdock/ui/reui/badge";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

export function CloudCta() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6 py-16 md:px-8">
      <Frame className="w-full">
        <FramePanel className="relative isolate overflow-hidden bg-muted/35 px-5 py-14 text-center sm:px-8 sm:py-16">
          <CtaGridBackground />
          <div className="relative mx-auto flex max-w-[42rem] flex-col items-center gap-8">
            <Badge variant="secondary" size="lg" className="gap-1.5">
              <CloudIcon aria-hidden="true" />
              PermDock Cloud
            </Badge>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Governance when you want it
            </h2>
            <p className="max-w-[34rem] text-base leading-7 text-muted-foreground">
              Dashboard at{" "}
              <Link
                href={site.cloud.app}
                className="text-foreground underline-offset-4 hover:underline"
              >
                app.permdock.com
              </Link>
              . API at{" "}
              <Link
                href={site.cloud.api}
                className="text-foreground underline-offset-4 hover:underline"
              >
                api.permdock.com
              </Link>
              . Read-only MCP at{" "}
              <Link
                href={site.cloud.mcp}
                className="text-foreground underline-offset-4 hover:underline"
              >
                mcp.permdock.com
              </Link>
              . The in-process defaults stay in the MIT package either way.
            </p>
            <ButtonLink href={site.cloud.app}>
              Open Cloud
              <ArrowRightIcon aria-hidden="true" />
            </ButtonLink>
          </div>
        </FramePanel>
      </Frame>
    </section>
  );
}
