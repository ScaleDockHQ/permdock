import { describe, expectTypeOf, it } from "vitest";

import type { A2aPermDockOptions } from "../../src/a2a/index.ts";
import type { AiSdkPermDockOptions } from "../../src/ai-sdk/index.ts";
import type { AuthzenPermDockOptions } from "../../src/authzen/index.ts";
import type { ClaudeAgentPermDockOptions } from "../../src/claude-agent/index.ts";
import type { ConvexPermDockOptions } from "../../src/convex/index.ts";
import type { ElysiaPermDockOptions } from "../../src/elysia/index.ts";
import type { EvePermDockOptions } from "../../src/eve/index.ts";
import type { ExpressPermDockOptions } from "../../src/express/index.ts";
import type { FastifyPermDockOptions } from "../../src/fastify/index.ts";
import type { HonoPermDockOptions } from "../../src/hono/index.ts";
import type { InstanceOptions } from "../../src/index.ts";
import type { McpPermDockOptions } from "../../src/mcp/index.ts";
import type { NestPermDockOptions } from "../../src/nest/index.ts";
import type { NextPermDockOptions } from "../../src/next/index.ts";
import type { NodePermDockOptions } from "../../src/node/index.ts";
import type { OpenAiPermDockOptions } from "../../src/openai/index.ts";
import type { OrpcPermDockOptions } from "../../src/orpc/index.ts";
import type { ServerPermDockOptions } from "../../src/server/index.ts";
import type { SupabaseMiddlewarePermDockOptions } from "../../src/supabase/middleware.ts";
import type { TerminalPermDockOptions } from "../../src/terminal/index.ts";
import type { TrpcPermDockOptions } from "../../src/trpc/index.ts";

describe("adapter options", () => {
  it("every adapter that builds an instance accepts the instance options", () => {
    expectTypeOf<A2aPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<AiSdkPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<AuthzenPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<ClaudeAgentPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<ConvexPermDockOptions<unknown>>().toExtend<InstanceOptions>();
    expectTypeOf<ElysiaPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<EvePermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<ExpressPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<FastifyPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<HonoPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<McpPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<NestPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<NextPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<NodePermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<OpenAiPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<OrpcPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<ServerPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<SupabaseMiddlewarePermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<TerminalPermDockOptions>().toExtend<InstanceOptions>();
    expectTypeOf<TrpcPermDockOptions>().toExtend<InstanceOptions>();
  });
});
