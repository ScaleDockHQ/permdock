import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { createPermDock } from "../../src/claude-agent/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const Refund = z.object({ amount: z.number(), to: z.string() });
const permissions = definePermissions({
  refund: resource(Refund, { collection: ["create"] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("clerk", [allow(permissions.refund.create, { approval: "human" })]),
  ],
  subject: (
    user: { readonly id: string; readonly roles: readonly string[] } | null,
  ) => (user === null ? null : { id: user.id, roles: user.roles }),
});
const signal = new AbortController().signal;

describe("an approval covers the arguments it was given", () => {
  it("does not let an approved collection call run with other arguments", async () => {
    const store = memoryApprovalStore();
    const { canUseTool } = createPermDock(policy, {
      subject: () => ({ id: "u1", roles: ["clerk"] }),
      tools: {
        Refund: {
          permission: permissions.refund.create,
          data: (args: unknown) => args,
        },
      },
      store,
    });

    const parked = await canUseTool(
      "Refund",
      { amount: 5, to: "c_1" },
      { signal },
    );
    expect(parked.behavior).toBe("deny");
    const [pending] = (await store.list({ status: "pending" })).items;
    if (pending === undefined) {
      throw new Error("expected a pending approval");
    }
    await store.resolve(pending.token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["clerk"] }, context: {} },
    });

    const swapped = await canUseTool(
      "Refund",
      { amount: 5000, to: "c_attacker" },
      { signal },
    );
    expect(swapped.behavior).toBe("deny");
    expect((await store.get(pending.token))?.consumedAt).toBeUndefined();

    expect(
      await canUseTool("Refund", { amount: 5, to: "c_1" }, { signal }),
    ).toEqual({ behavior: "allow", updatedInput: { amount: 5, to: "c_1" } });
  });
});
