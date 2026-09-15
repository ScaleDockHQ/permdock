import Link from 'next/link';

import { AgentActivity } from '@/components/blocks/agent-activity-1/components/agent-activity';
import { Badge } from '@/components/reui/badge';
import { agentRuntimes } from '@/lib/site';

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
            render={<Link href={runtime.href} />}
          >
            {runtime.name}
          </Badge>
        ))}
      </div>
      <div className="w-full overflow-x-auto">
        <AgentActivity />
      </div>
    </Section>
  );
}
