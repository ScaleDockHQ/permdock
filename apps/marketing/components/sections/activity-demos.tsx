"use client";

import dynamic from "next/dynamic";

function Placeholder({ className }: { readonly className: string }) {
  return <div aria-hidden="true" className={className} />;
}

/** The agent run demo, loaded after the page; the placeholder holds its height. */
export const AgentRunDemo = dynamic(
  () =>
    import("@/components/blocks/agent-activity-1/components/agent-activity").then(
      (module) => module.AgentActivity,
    ),
  {
    ssr: false,
    loading: () => <Placeholder className="h-120 w-full max-w-xl md:h-80" />,
  },
);

/** The MCP tool-call demo, loaded after the page; the placeholder holds its height. */
export const McpRunDemo = dynamic(
  () =>
    import("@/components/blocks/agent-activity-4/components/agent-activity").then(
      (module) => module.AgentActivity,
    ),
  {
    ssr: false,
    loading: () => <Placeholder className="h-170 w-full max-w-2xl md:h-83" />,
  },
);
