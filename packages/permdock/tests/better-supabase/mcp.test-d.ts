import { type defineSchema, defineSupabase } from "better-supabase";
import { createMcp, defineTool } from "better-supabase/mcp";
import { describe, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { mayUse } from "../../src/core/may-use.ts";
import { isPermission, type Permission } from "../../src/core/permissions.ts";

declare const schema: ReturnType<typeof defineSchema>;
declare function dockFor(ctx: unknown): Promise<PermDock>;
declare const exportCustomers: Permission;

const betterSupabase = defineSupabase(schema);

describe("better-supabase's createMcp with PermDock permissions as tool meta", () => {
  it("narrows meta with isPermission before mayUse", () => {
    createMcp(betterSupabase, {
      name: "crm",
      version: "1.0.0",
      tools: [
        defineTool({
          name: "export_customers",
          description: "Export the customers.",
          meta: exportCustomers,
          run: () => null,
        }),
      ],
      authorize: async (ctx, tool) => {
        if (!isPermission(tool.meta)) return { allowed: true };
        expectTypeOf(tool.meta).toEqualTypeOf<Permission>();
        return mayUse(await dockFor(ctx), tool.meta)
          ? { allowed: true }
          : { allowed: false, reason: "PermDock denied this tool" };
      },
      visible: async (ctx, tool) =>
        !isPermission(tool.meta) || mayUse(await dockFor(ctx), tool.meta),
    });
  });

  it("rejects passing meta to mayUse without narrowing", () => {
    createMcp(betterSupabase, {
      name: "crm",
      version: "1.0.0",
      visible: async (ctx, tool) =>
        // @ts-expect-error meta is unknown until isPermission narrows it
        mayUse(await dockFor(ctx), tool.meta),
    });
  });
});
