import { ButtonLink } from "@/components/site/button-link";
import { ScrollRegion } from "@/components/site/scroll-region";
import { compareMatrix } from "@/lib/compare";
import { site } from "@/lib/site";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

export const metadata = {
  title: "Pricing",
  description:
    "The MIT package is free. Cloud tiers are placeholders until pricing is announced.",
};

const tiers = [
  {
    name: "Open source",
    price: "Free",
    body: "MIT. Everything in-process: core, adapters, CLI, in-memory stores and sinks.",
    cta: { href: site.getStarted, label: "Get started" },
  },
  {
    name: "Cloud Free",
    price: "To be announced",
    body: "Hosted decision log and snapshots. Pricing to be announced.",
    cta: { href: site.cloud.app, label: "Open Cloud" },
  },
  {
    name: "Cloud Team",
    price: "To be announced",
    body: "Approval inbox and shared evidence export. Pricing to be announced.",
    cta: { href: site.cloud.app, label: "Open Cloud" },
  },
  {
    name: "Cloud Enterprise",
    price: "Contact",
    body: "SCIM relay, FAPI 2.0 profile, self-hosting options. Contact us.",
    cta: { href: "/enterprise", label: "Talk to us" },
  },
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-16 md:px-8">
      <div className="mb-12 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Pricing
        </h1>
        <p className="mt-3 text-base leading-7 text-muted-foreground">
          The library is free. Cloud tiers below are placeholders. Nothing in
          Cloud sits on the decision path.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {tiers.map((tier) => (
          <Frame key={tier.name}>
            <FramePanel className="flex h-full flex-col gap-4">
              <p className="text-sm font-semibold">{tier.name}</p>
              <p className="text-2xl font-semibold">{tier.price}</p>
              <p className="flex-1 text-sm leading-6 text-muted-foreground">
                {tier.body}
              </p>
              <ButtonLink href={tier.cta.href}>{tier.cta.label}</ButtonLink>
            </FramePanel>
          </Frame>
        ))}
      </div>
      <ScrollRegion aria-label="Capability comparison" className="mt-16">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-3 pr-4 font-medium">Capability</th>
              <th className="py-3 pr-4 font-medium">Open source</th>
              <th className="py-3 pr-4 font-medium">Typical library</th>
              <th className="py-3 font-medium">Hosted PDP</th>
            </tr>
          </thead>
          <tbody>
            {compareMatrix.map((row) => (
              <tr key={row.feature} className="border-b border-border">
                <td className="py-3 pr-4 font-medium">{row.feature}</td>
                <td className="py-3 pr-4">{row.permdock}</td>
                <td className="py-3 pr-4 text-muted-foreground">
                  {row.typicalLibrary}
                </td>
                <td className="py-3 text-muted-foreground">{row.hostedPdp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
