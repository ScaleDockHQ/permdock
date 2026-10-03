import { ScrollRegion } from '@/components/site/scroll-region';
import { SiteLink } from '@/components/site/site-link';
import { agentRuntimes } from '@/lib/site';
import { Badge } from '@permdock/ui/reui/badge';

import { AgentRunDemo } from './activity-demos';
import { Section } from './section';

export function AgentNative() {
  return (
    <Section
      id="agents"
      eyebrow="Agent-native"
      title="The same Decision gates the tool call"
      description="granted, denied and approval-required map onto MCP, the Vercel AI SDK, the Claude Agent SDK, Eve, OpenAI Agents, WebMCP and A2A. An agent never approves its own call."
    >
      <div className="mb-6 flex flex-wrap gap-2">
        {agentRuntimes.map((runtime) => (
          <Badge
            key={runtime.name}
            variant="outline"
            render={<SiteLink href={runtime.href} />}
          >
            {runtime.name}
          </Badge>
        ))}
      </div>
      <ScrollRegion aria-label="Agent activity" className="w-full">
        <AgentRunDemo />
      </ScrollRegion>
    </Section>
  );
}
