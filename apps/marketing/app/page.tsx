import { Hero } from "@/components/blocks/hero-5/components/hero";
import { AgentNative } from "@/components/sections/agent-native";
import { Closer } from "@/components/sections/closer";
import { CloudBand } from "@/components/sections/cloud-band";
import { DecideExplorer } from "@/components/sections/decide-explorer";
import { FaqSection } from "@/components/sections/faq";
import { Features } from "@/components/sections/features";
import { GetStarted } from "@/components/sections/get-started";
import { PortableConditions } from "@/components/sections/portable";
import { RecentShips } from "@/components/sections/recent-ships";
import { SecureByDefault } from "@/components/sections/secure";
import { Surfaces } from "@/components/sections/surfaces";
import { WorksWith } from "@/components/sections/works-with";
import { loadRecentShips } from "@/lib/changelogs";

export default function HomePage() {
  const ships = loadRecentShips(3);
  return (
    <>
      <Hero version={ships[0]?.version} />
      <Features />
      <Surfaces />
      <DecideExplorer />
      <PortableConditions />
      <AgentNative />
      <SecureByDefault />
      <WorksWith />
      {ships.length > 0 ? <RecentShips releases={ships} /> : null}
      <GetStarted />
      <CloudBand />
      <FaqSection />
      <Closer />
    </>
  );
}
