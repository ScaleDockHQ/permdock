import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgentKernel } from "../../src/agent/kernel.ts";
import { PermDockValidationError } from "../../src/core/validation-error.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "../../src/index.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const Invoice = z.object({ id: z.string(), amount: z.number() });
const permissions = definePermissions({
  invoice: resource(Invoice, { id: "id", collection: ["create"] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.invoice.create),
      deny(permissions.invoice.create, { check: { amount: { gt: 1000 } } }),
    ]),
  ],
  subject: (
    user: { readonly id: string; readonly roles: readonly string[] } | null,
  ) => (user === null ? null : { id: user.id, roles: user.roles }),
  validate: "boundary",
});
const user = { id: "u1", roles: ["member"] };

describe("tool arguments are boundary data", () => {
  const kernel = createAgentKernel(policy, {
    adapter: "test",
    subject: () => user,
    tools: {
      create_invoice: {
        permission: permissions.invoice.create,
        data: (args: unknown) => args,
      },
    },
  });

  it("denies a schema-invalid object built from tool arguments", async () => {
    const result = await kernel.decideTool(
      "create_invoice",
      { id: "i1", amount: "50000" },
      {},
    );
    expect(result.outcome).toBe("denied");
    expect(
      result.decision === null ? undefined : reasonOf(result.decision),
    ).toBe("validation");
  });

  it("still applies the deny to a valid object", async () => {
    const result = await kernel.decideTool(
      "create_invoice",
      { id: "i1", amount: 50_000 },
      {},
    );
    expect(result.outcome).toBe("denied");
    expect(
      result.decision === null ? undefined : reasonOf(result.decision),
    ).toBe("deny");
  });

  it("matches a direct decide on untrusted data", async () => {
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.invoice.create, {
      id: "i1",
      amount: "50000",
    });
    expect(reasonOf(decision)).toBe("validation");
  });

  it("names the adapter's boundary in the validation error", async () => {
    const boundaryOf = async (
      boundary: "mcp-args" | undefined,
    ): Promise<unknown> => {
      const named = createAgentKernel(policy, {
        adapter: "test",
        subject: () => user,
        ...(boundary === undefined ? {} : { boundary }),
      });
      const checked = await named.check(
        {
          permission: permissions.invoice.create,
          data: (args: unknown) => args,
        },
        { id: "i1", amount: "50000" },
        {},
      );
      if (!checked.ok || checked.decision.outcome !== "denied") {
        return undefined;
      }
      const [denial] = checked.decision.denials;
      return denial?.detail instanceof PermDockValidationError
        ? denial.detail.boundary
        : undefined;
    };
    expect(await boundaryOf(undefined)).toBe("tool-args");
    expect(await boundaryOf("mcp-args")).toBe("mcp-args");
  });
});
