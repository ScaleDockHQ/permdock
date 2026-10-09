import { type defineSchema, defineSupabase } from "better-supabase";
import { createMcp, defineTool } from "better-supabase/mcp";
import { describe, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { toolPolicy } from "../../src/better-supabase/index.ts";
import { isPermission, type Permission } from "../../src/core/permissions.ts";

declare const schema: ReturnType<typeof defineSchema>;
declare function dockFor(ctx: unknown): Promise<PermDock>;
declare const exportCustomers: Permission;

const betterSupabase = defineSupabase(schema);

describe("better-supabase's createMcp with PermDock permissions as tool meta", () => {
  it("takes toolPolicy's hooks", () => {
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
      ...toolPolicy({ permdock: dockFor }),
    });
  });

  it("narrows meta with isPermission and fails closed without one", () => {
    createMcp(betterSupabase, {
      name: "crm",
      version: "1.0.0",
      authorize: async (ctx, tool) => {
        if (!isPermission(tool.meta)) {
          return { allowed: false, reason: "No permission" };
        }
        expectTypeOf(tool.meta).toEqualTypeOf<Permission>();
        return (await dockFor(ctx)).can(tool.meta, undefined)
          ? { allowed: true }
          : { allowed: false, reason: "PermDock denied this tool" };
      },
    });
  });

  it("rejects passing meta to can without narrowing", () => {
    createMcp(betterSupabase, {
      name: "crm",
      version: "1.0.0",
      visible: async (ctx, tool) =>
        // @ts-expect-error meta is unknown until isPermission narrows it
        (await dockFor(ctx)).can(tool.meta, undefined),
    });
  });
});
