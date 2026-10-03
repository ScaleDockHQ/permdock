import { ButtonLink } from "@/components/site/button-link";
import { site } from "@/lib/site";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

import { Section } from "./section";

export function CloudBand() {
  return (
    <Section
      id="cloud"
      eyebrow="Optional"
      title="The Cloud is optional"
      description="Every hosted capability has an in-process default. A store or sink never influences an outcome. Cloud outages do not change can() or decide()."
    >
      <Frame>
        <FramePanel className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Decision log as evidence, hosted AuthZEN ADS, approval inbox, SCIM
            relay. None of it sits on the decision path.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href="/cloud">PermDock Cloud</ButtonLink>
            <ButtonLink variant="outline" href={site.cloud.app}>
              Open Cloud
            </ButtonLink>
          </div>
        </FramePanel>
      </Frame>
    </Section>
  );
}
