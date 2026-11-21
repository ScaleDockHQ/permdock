import type { EveToolApproval } from "better-supabase/eve";

import {
  approvalPolicy,
  strictestApproval,
  supabaseTool,
  tenantToolApproval,
} from "better-supabase/eve";
import { describe, expectTypeOf, it } from "vitest";

import { createPermDock } from "../../src/eve/index.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

declare const server: Parameters<typeof approvalPolicy>[0]["server"];
declare const source: Parameters<typeof tenantToolApproval>[0];
declare const inputSchema: Parameters<typeof supabaseTool>[0]["inputSchema"];

const permdock = createPermDock(policy, {
  operations: { delete_post: { permission: permissions.post.delete } },
});

describe("better-supabase's eve tools with permdock/eve", () => {
  it("takes approvalFor as an approval beside its own policies", () => {
    expectTypeOf(
      permdock.approvalFor(permissions.post.delete),
    ).toExtend<EveToolApproval>();
    const approval = strictestApproval(
      permdock.approvalFor(permissions.post.delete),
      approvalPolicy({
        agent: "support",
        permission: permissions.post.delete.key,
        server,
      }),
      tenantToolApproval(source),
    );
    expectTypeOf(approval).toExtend<EveToolApproval>();
  });

  it("names the same permission on supabaseTool", () => {
    supabaseTool({
      agent: "support",
      approval: strictestApproval(
        permdock.approvalFor(permissions.post.delete),
      ),
      description: "Delete a post.",
      execute: () => "deleted",
      inputSchema,
      permission: permissions.post.delete.key,
      server,
    });
  });
});
