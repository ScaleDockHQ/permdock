import type { McpServer } from "@modelcontextprotocol/server";

import type { Policy } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type { McpChecks } from "./call-check.ts";
import type { McpCall } from "./mcp-auth.ts";
import type {
  McpOnError,
  McpPermDock,
  McpPermDockOptions,
  McpProcedureEnforcement,
} from "./types.ts";

import { createAgentKernel } from "../agent/kernel.ts";
import { withApp } from "../core/app.ts";
import { clientNameOf } from "../core/clients.ts";
import { compact } from "../core/compact.ts";
import { delegationFrom } from "../core/delegation-input.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { composeWraps } from "../core/wrap.ts";
import { tenantOf } from "./mcp-auth.ts";
import { protectServer } from "./protect-server.ts";
import { mcpActorKind } from "./subject.ts";

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  given: McpPermDockOptions<TUser>,
): McpPermDock {
  const options = withApp(policy, given);
  const actorKind = mcpActorKind(options.actorKind);
  if (actorKind === undefined) {
    throw new TypeError("permdock/mcp: actorKind must be a non-empty string");
  }
  const kernel = createAgentKernel<McpCall, TUser>(
    // SAFETY: the kernel reads the principal only through the policy's own subject function.
    policy as Policy<TUser>,
    compact({
      subject: (call: McpCall) => options.subject(call.authInfo ?? {}),
      actor: (call: McpCall) => {
        if (options.actor !== undefined) {
          return options.actor(call.authInfo ?? {});
        }
        const clientId = call.authInfo?.clientId;
        return typeof clientId === "string" && clientId !== ""
          ? compact({
              id: clientId,
              kind: actorKind,
              client: clientNameOf(options.clients, clientId),
            })
          : undefined;
      },
      delegation: (call: McpCall) => {
        if (options.delegation !== undefined) {
          return options.delegation(call.authInfo ?? {});
        }
        return call.authInfo === undefined
          ? undefined
          : delegationFrom(call.authInfo.scopes, call.authInfo.extra);
      },
      tenant: tenantOf(options.tenant),
      store: options.store,
      adapter: "mcp",
      boundary: "mcp-args" as const,
      wrap: composeWraps(options.otel, options.wrap),
      context:
        options.context === undefined
          ? undefined
          : (call: McpCall): ReturnType<NonNullable<typeof options.context>> =>
              options.context?.(call.authInfo ?? {}),
      ...instanceOptions(options),
    }),
  );

  const checks: McpChecks = {
    // SAFETY: the checks read the policy's permissions and scopes, which do not depend on TUser.
    policy: policy as Policy,
    options,
    kernel,
  };

  // SAFETY: the implementation returns ProcedureMcpServer exactly when given McpProcedureEnforcement.
  return {
    protectServer: ((
      server: McpServer,
      enforcement?: McpProcedureEnforcement | McpOnError,
      onError?: McpOnError,
    ) => {
      const sink = typeof enforcement === "function" ? enforcement : onError;
      const next: McpChecks =
        sink === undefined ? checks : { ...checks, onError: sink };
      return protectServer(
        next,
        server,
        typeof enforcement === "function" ? undefined : enforcement,
      );
    }) as McpPermDock["protectServer"],
  };
}
