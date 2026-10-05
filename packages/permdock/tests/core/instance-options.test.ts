import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { InstanceOptions } from "../../src/core/instance-options.ts";
import type { Subject } from "../../src/core/subject.ts";

import { createAgentKernel } from "../../src/agent/kernel.ts";
import { memoryApprovalPolicies } from "../../src/core/approval-policies.ts";
import { instanceOptions } from "../../src/core/instance-options.ts";
import { createPermDock as createHonoPermDock } from "../../src/hono/create.ts";
import { createPermDock as createServerPermDock } from "../../src/server/create.ts";
import { permissions, policy, rows } from "../fixtures/expenses.ts";

const [large] = rows.expense;

const alice: Subject = {
  principal: {
    id: "alice",
    tenant: "o1",
    memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  },
  context: {},
};

const approvalPolicies = memoryApprovalPolicies([
  {
    permission: "expense.read",
    tenant: "o1",
    approval: { by: "finance" },
  },
]);

describe("instanceOptions", () => {
  it("keeps the set data sources and drops adapter options", () => {
    const sink = { write: (): void => undefined };
    const adapterOptions = {
      sink,
      approvalPolicies,
      limits: undefined,
      subject: () => null,
      store: {},
    };
    // SAFETY: an adapter's options object: two sources, one unset source and two adapter keys.
    const options = adapterOptions as unknown as InstanceOptions;
    expect(instanceOptions(options)).toEqual({ sink, approvalPolicies });
  });
});

describe("adapters forward InstanceOptions to core", () => {
  it("applies approvalPolicies through the HTTP kernel", async () => {
    const server = createServerPermDock(policy, {
      subject: () => alice,
      approvalPolicies,
    });
    const permdock = await server.permdock(new Request("https://app.test/"));
    expect(permdock.decide(permissions.expense.read, large).outcome).toBe(
      "approval-required",
    );
  });

  it("applies approvalPolicies through the agent kernel", async () => {
    const kernel = createAgentKernel<object>(policy, {
      subject: () => alice,
      tools: {
        read: { permission: permissions.expense.read, data: () => large },
      },
      approvalPolicies,
      adapter: "test",
    });
    const permdock = await kernel.instance({});
    expect(permdock.decide(permissions.expense.read, large).outcome).toBe(
      "approval-required",
    );
  });

  it("resolves an HTTP adapter's actor from its own context", async () => {
    const hono = createHonoPermDock(policy, {
      subject: () => ({ id: "alice" }),
      actor: (c) =>
        c.req.header("x-agent") === undefined
          ? undefined
          : { id: c.req.header("x-agent"), kind: "agent" },
    });
    const app = new Hono()
      .use(hono.permdock())
      .get("/", (c) => c.json(c.get("permdock").subject.actor ?? null));
    const acting = await app.request("/", { headers: { "x-agent": "bot" } });
    expect(await acting.json()).toEqual({ id: "bot", kind: "agent" });
    expect(await (await app.request("/")).json()).toBeNull();
  });
});
