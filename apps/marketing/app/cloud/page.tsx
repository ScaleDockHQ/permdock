import { ClipboardListIcon, InboxIcon, ShieldIcon } from 'lucide-react';

import { AgentActivity } from '@/components/blocks/agent-activity-1/components/agent-activity';
import { AgentActivity as McpActivity } from '@/components/blocks/agent-activity-4/components/agent-activity';
import { PageHero } from '@/components/sections/page-hero';
import { Section } from '@/components/sections/section';
import { WaitlistCta } from '@/components/sections/waitlist';

export const metadata = {
  title: 'Cloud',
  description:
    'Optional decision log, hosted AuthZEN ADS, approval inbox and SCIM relay. Never on the decision path.',
};

export default function CloudPage() {
  return (
    <>
      <PageHero
        badge="Optional"
        badgeHref="/docs/adapters/cloud"
        title="Governance first. Decisions stay local."
        description="PermDock Cloud is a decision log sold as evidence, a hosted AuthZEN ADS, an approval inbox, and a SCIM relay into a DirectoryStore you own. Every hosted capability has an in-process default in the MIT package."
        primary={{ href: '#waitlist', label: 'Join waitlist' }}
        secondary={{ href: '/docs/adapters/cloud', label: 'Cloud adapter' }}
        features={[
          {
            title: 'Decision log as evidence',
            description:
              'Signed batches with typ permdock-decisions+jwt. A sink never changes an outcome.',
            href: '/docs/concepts/audit-and-observability',
            icon: <ClipboardListIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'Approval inbox',
            description:
              'Humans resume. The token is bound to permission, resource, subject and actor.',
            href: '/docs/security/approvals',
            icon: <InboxIcon aria-hidden="true" className="size-4" />,
          },
          {
            title: 'SCIM relay',
            description:
              'Provisioning into a DirectoryStore you own. The Cloud holds no authoritative directory copy.',
            href: '/docs/adapters/scim',
            icon: <ShieldIcon aria-hidden="true" className="size-4" />,
          },
        ]}
      />
      <Section
        title="Human gates stay in the run"
        description="The same approval-required Decision the agent runtime already halted on. Cloud hosts the inbox; decide() still runs in your process."
      >
        <div className="overflow-x-auto">
          <AgentActivity />
        </div>
      </Section>
      <Section
        title="Refused MCP scope stays refused"
        description="A missing grant is denied, not a boolean false with no reason. The table is an illustration of protectServer, not a live PDP."
      >
        <div className="overflow-x-auto">
          <McpActivity />
        </div>
      </Section>
      <div id="waitlist">
        <WaitlistCta />
      </div>
    </>
  );
}
