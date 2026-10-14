import type { AgentRuntimeContext } from "../../src/testing/agent-runtime.ts";

import { createPermDock } from "../../src/agent/index.ts";
import { createPermDock as createOpenAi } from "../../src/openai/index.ts";
import { testAgentRuntime } from "../../src/testing/agent-runtime.ts";

function contextOf(value: unknown): AgentRuntimeContext {
  // SAFETY: the runner passes an AgentRuntimeContext as every call's context.
  return value as AgentRuntimeContext;
}

testAgentRuntime({
  name: "permdock/agent",
  mount: (domain) => ({
    agent: createPermDock(domain.policy, {
      subject: (context: AgentRuntimeContext) =>
        domain.subject(context.user, context.org),
      tenant: (context) => context.org,
      operations: domain.operations,
      models: domain.models,
      store: domain.store,
      customRoles: domain.customRoles,
    }),
  }),
});

testAgentRuntime({
  name: "permdock/openai",
  mount: (domain) => ({
    agent: createOpenAi(domain.policy, {
      subject: (context) => {
        const { user, org } = contextOf(context);
        return domain.subject(user, org);
      },
      tenant: (context) => contextOf(context).org,
      operations: domain.operations,
      models: domain.models,
      store: domain.store,
      customRoles: domain.customRoles,
    }),
  }),
});
