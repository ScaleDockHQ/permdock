import { invariants } from "@/lib/invariants";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

import { Section } from "./section";

export function SecureByDefault() {
  return (
    <Section
      id="secure"
      eyebrow="Secure by default"
      title="Invariants, not a later pass"
      description="A PR that breaks one of these is wrong, whatever else it does."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {invariants.map((item) => (
          <Frame key={item.title}>
            <FramePanel className="flex flex-col gap-2">
              <h3 className="text-base font-semibold">{item.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">
                {item.body}
              </p>
            </FramePanel>
          </Frame>
        ))}
      </div>
    </Section>
  );
}
