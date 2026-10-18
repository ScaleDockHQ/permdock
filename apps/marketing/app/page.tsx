import type { Metadata } from "next";

import { Hero } from "@/components/blocks/hero-5/components/hero";
import { AgentNative } from "@/components/sections/agent-native";
import { Closer } from "@/components/sections/closer";
import { CloudBand } from "@/components/sections/cloud-band";
import { DecideExplorer } from "@/components/sections/decide-explorer";
import { FaqSection } from "@/components/sections/faq";
import { Features } from "@/components/sections/features";
import { GetStarted } from "@/components/sections/get-started";
import { PortableConditions } from "@/components/sections/portable";
import { SecureByDefault } from "@/components/sections/secure";
import { Surfaces } from "@/components/sections/surfaces";
import { WorksWith } from "@/components/sections/works-with";
import { JsonLd } from "@/components/site/json-ld";
import { loadRecentShips } from "@/lib/changelogs";
import { faqItems } from "@/lib/faq";
import {
  faqPage,
  organization,
  sourceCode,
  website,
} from "@/lib/structured-data";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  const ships = loadRecentShips(1);
  return (
    <>
      <JsonLd
        nodes={[
          organization(),
          website(),
          sourceCode(ships[0]?.version),
          faqPage(faqItems),
        ]}
      />
      <Hero version={ships[0]?.version} />
      <Features />
      <Surfaces />
      <DecideExplorer />
      <PortableConditions />
      <AgentNative />
      <SecureByDefault />
      <WorksWith />
      <GetStarted />
      <CloudBand />
      <FaqSection />
      <Closer />
    </>
  );
}
