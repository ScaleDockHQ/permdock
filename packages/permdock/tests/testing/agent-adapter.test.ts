import type { AuthInfo } from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type {
  AgentCall,
  AgentOutcome,
  AgentScenarioDomain,
} from "../../src/testing/agent-adapter.ts";

import { createPermDock as createA2a } from "../../src/a2a/index.ts";
import { createPermDock as createAiSdk } from "../../src/ai-sdk/index.ts";
import { createPermDock as createClaudeAgent } from "../../src/claude-agent/index.ts";
import { createPermDock as createEve } from "../../src/eve/index.ts";
import { createPermDock as createMcp } from "../../src/mcp/index.ts";
import { createPermDock as createOpenAi } from "../../src/openai/index.ts";
import {
  createPermDock as createTerminal,
  EX_NOPERM,
  EX_OK,
  EX_TEMPFAIL,
  TerminalExit,
} from "../../src/terminal/index.ts";
import { testAgentAdapter } from "../../src/testing/agent-adapter.ts";

type CallContext = { readonly user: string | null; readonly org: string };

function callContext(value: unknown): CallContext {
  // SAFETY: every mount below passes a CallContext as the adapter's context.
  return value as CallContext;
}

function subjectOf(domain: AgentScenarioDomain) {
  return (context: unknown) => {
    const { user, org } = callContext(context);
    return domain.subject(user, org);
  };
}

const tenantOf = (context: unknown): string => callContext(context).org;

testAgentAdapter({
  name: "permdock/ai-sdk",
  mount: (domain) => {
    const permdock = createAiSdk(domain.policy, {
      subject: (context) => subjectOf(domain)(context.runtimeContext),
      tenant: (context) => tenantOf(context.runtimeContext),
      tools: domain.tools,
      store: domain.store,
      customRoles: domain.customRoles,
    });
    return {
      call: async ({ user, org, tool, args }) => {
        const status = await permdock.toolApproval({
          toolCall: { toolName: tool, toolCallId: "c1", input: args },
          runtimeContext: { user, org },
        });
        if (status === "approved") {
          return "granted";
        }
        return status.type === "user-approval" ? "approval-required" : "denied";
      },
    };
  },
});

testAgentAdapter({
  name: "permdock/openai",
  mount: (domain) => {
    const permdock = createOpenAi(domain.policy, {
      subject: subjectOf(domain),
      tenant: tenantOf,
      tools: domain.tools,
      store: domain.store,
      customRoles: domain.customRoles,
    });
    return {
      call: async ({ user, org, tool, args }) => {
        let outcome: AgentOutcome = "approval-required";
        const state = {
          approve: () => {
            outcome = "granted";
          },
          reject: () => {
            outcome = "denied";
          },
        };
        const item = { name: tool, arguments: JSON.stringify(args) };
        await permdock.resolveInterruptions(state, [item], {
          context: { user, org },
        });
        return outcome;
      },
    };
  },
});

testAgentAdapter({
  name: "permdock/claude-agent",
  mount: (domain) => ({
    call: async ({ user, org, tool, args }) => {
      const permdock = createClaudeAgent(domain.policy, {
        subject: () => domain.subject(user, org),
        tenant: org,
        tools: domain.tools,
        store: domain.store,
        customRoles: domain.customRoles,
      });
      const result = await permdock.canUseTool(tool, { ...args });
      if (result.behavior === "allow") {
        return "granted";
      }
      return result.message.includes(" is pending;")
        ? "approval-required"
        : "denied";
    },
  }),
});

testAgentAdapter({
  name: "permdock/eve",
  mount: (domain) => {
    const { approval } = createEve(domain.policy, {
      subject: (context) => {
        const current = context.session?.auth?.current;
        const org = current?.attributes?.["org"];
        return domain.subject(
          current?.principalId ?? null,
          typeof org === "string" ? org : "",
        );
      },
      tenant: (context) => {
        const org = context.session?.auth?.current?.attributes?.["org"];
        return typeof org === "string" ? org : undefined;
      },
      delegation: () => ({
        scopes: Object.values(domain.tools).map(
          (binding) => binding.permission.scope,
        ),
      }),
      tools: domain.tools,
      store: domain.store,
      customRoles: domain.customRoles,
    });
    return {
      call: async ({ user, org, tool, args }) => {
        const principal =
          user === null ? null : { principalId: user, attributes: { org } };
        const result = await approval.request({
          session: {
            id: "s1",
            auth: { initiator: principal, current: principal },
          },
          callId: "c1",
          toolName: tool,
          toolInput: args,
        });
        if (result === "not-applicable") {
          return "granted";
        }
        return result === "user-approval" ? "approval-required" : "denied";
      },
    };
  },
});

testAgentAdapter({
  name: "permdock/mcp",
  mount: async (domain) => {
    const session: { authInfo: AuthInfo | undefined } = {
      authInfo: undefined,
    };
    const extraOf = (authInfo: { readonly extra?: unknown }): CallContext => {
      const { extra } = authInfo;
      return extra === undefined ? { user: null, org: "" } : callContext(extra);
    };
    const server = new McpServer({ name: "saas", version: "1.0.0" });
    const guarded = createMcp(domain.policy, {
      subject: (authInfo) => {
        const { user, org } = extraOf(authInfo);
        return domain.subject(user, org);
      },
      tenant: (authInfo) => extraOf(authInfo).org,
      store: domain.store,
      customRoles: domain.customRoles,
    }).protectServer(server);
    const input = z.object({ id: z.string().optional() });
    for (const [name, binding] of Object.entries(domain.tools)) {
      guarded.registerTool(name, { ...binding, inputSchema: input }, () => ({
        content: [{ type: "text", text: "ok" }],
      }));
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) =>
      send(
        message,
        session.authInfo === undefined
          ? options
          : { ...options, authInfo: session.authInfo },
      );
    await server.connect(serverSide);
    const client = new Client({ name: "tester", version: "1.0.0" });
    await client.connect(clientSide);
    const scopes = Object.values(domain.tools).map(
      (binding) => binding.permission.scope,
    );
    return {
      call: async ({ user, org, tool, args }) => {
        session.authInfo =
          user === null
            ? undefined
            : { token: "t", clientId: "agent", scopes, extra: { user, org } };
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError !== true) {
          return "granted";
        }
        const content: { readonly outcome?: unknown } =
          result.structuredContent ?? {};
        const { outcome } = content;
        return outcome === "approval-required" ? outcome : "denied";
      },
      close: () => client.close(),
    };
  },
});

testAgentAdapter({
  name: "permdock/a2a",
  mount: (domain) => {
    let current: CallContext = { user: null, org: "" };
    const { protectSkill } = createA2a(domain.policy, {
      subject: (auth) =>
        auth.clientId === undefined ? null : subjectOf(domain)(current),
      tenant: () => current.org,
      card: { name: "SaaS agent", url: "https://agent.test/a2a", version: "1" },
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
      skills: Object.fromEntries(
        Object.entries(domain.tools).map(([id, binding]) => [
          id,
          {
            permission: binding.permission,
            data: async (task: unknown) => {
              // SAFETY: the mount sends every task as { skillId, args }.
              const { args } = task as { readonly args: unknown };
              return binding.data?.(args);
            },
          },
        ]),
      ),
      store: domain.store,
      customRoles: domain.customRoles,
    });
    const run = protectSkill((task) =>
      // SAFETY: the mount sends every task as { skillId, args }.
      String((task as { readonly skillId: unknown }).skillId),
    );
    const scopes = Object.values(domain.tools).map(
      (binding) => binding.permission.scope,
    );
    return {
      call: async (call: AgentCall) => {
        current = { user: call.user, org: call.org };
        const result = await run(
          { skillId: call.tool, args: call.args },
          call.user === null ? {} : { clientId: "agent", scopes },
        );
        if (result.ok) {
          return "granted";
        }
        return result.state === "input-required"
          ? "approval-required"
          : "denied";
      },
    };
  },
});

testAgentAdapter({
  name: "permdock/terminal",
  mount: (domain) => ({
    call: async ({ user, org, tool, args }) => {
      const { protect } = createTerminal(domain.policy, {
        subject: () => domain.subject(user, org),
        tenant: org,
        customRoles: domain.customRoles,
        store: domain.store,
        interactive: false,
        runtime: {
          exit: (code) => {
            throw new TerminalExit(code);
          },
          write: () => undefined,
        },
      });
      const binding = domain.tools[tool];
      const run = protect(binding.permission, () => binding.data?.(args))(
        () => "ran",
      );
      try {
        await run();
        return "granted";
      } catch (error) {
        if (!(error instanceof TerminalExit)) {
          throw error;
        }
        switch (error.code) {
          case EX_OK:
            return "granted";
          case EX_TEMPFAIL:
            return "approval-required";
          case EX_NOPERM:
            return "denied";
          default:
            throw error;
        }
      }
    },
  }),
});
