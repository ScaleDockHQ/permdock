import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPermDock } from "../../src/agent/index.ts";
import { createPermDock as createAiSdk } from "../../src/ai-sdk/index.ts";
import {
  allow,
  defineOperations,
  definePermissions,
  definePolicy,
  memoryApprovalPolicySource,
  memoryDecisionSink,
  parseSinkEvent,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const Doc = z.object({ id: z.string(), ownerId: z.string() });
const Model = z.object({ id: z.string() });

const permissions = definePermissions({
  doc: resource(Doc, { id: "id", actions: ["read"], collection: ["search"] }),
  model: resource(Model, { id: "id", actions: ["use"], collection: ["basic"] }),
});

type User = { readonly id: string; readonly roles: readonly string[] };

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.doc.search),
      allow(permissions.doc.read, { where: { ownerId: principal.id } }),
      allow(permissions.model.basic),
    ]),
    role("pro", [
      allow(permissions.doc.search),
      allow(permissions.doc.read),
      allow(permissions.model.basic),
      allow(permissions.model.use, { where: { id: "openai/gpt-5" } }),
    ]),
  ],
  subject: (user: User | null) => user,
});

const operations = defineOperations(permissions, {
  search_docs: {
    permission: permissions.doc.search,
    results: permissions.doc.read,
    meta: { risk: "low", effects: ["read"] },
  },
  read_doc: {
    permission: permissions.doc.read,
    data: (input: { readonly id: string }) =>
      input.id === "d1" ? { id: "d1", ownerId: "u1" } : null,
  },
});

const models = {
  "openai/gpt-5": permissions.model.use,
  "openai/gpt-5-mini": permissions.model.basic,
};

type Context = { readonly user: User | null; readonly tenant?: string };

function agentFor(withModels = true) {
  return createPermDock(policy, {
    subject: (context: Context) => context.user,
    operations,
    ...(withModels ? { models } : {}),
  });
}

const member: Context = { user: { id: "u1", roles: ["member"] } };
const pro: Context = { user: { id: "u2", roles: ["pro"] } };

const rows = [
  { id: "d1", ownerId: "u1" },
  { id: "d2", ownerId: "u9" },
];

describe("permdock/agent createPermDock", () => {
  it("decides operations by name and denies an unlisted one", async () => {
    const agent = agentFor();
    const { outcome } = await agent.decideOperation(
      "read_doc",
      { id: "d1" },
      member,
    );
    expect(outcome).toBe("granted");
    expect(
      (await agent.decideOperation("read_doc", { id: "zz" }, member)).outcome,
    ).toBe("denied");
    expect((await agent.decideOperation("nope", {}, member)).outcome).toBe(
      "denied",
    );
    expect(await agent.allowedOperations(member)).toStrictEqual(
      new Set(["search_docs", "read_doc"]),
    );
  });

  it("gates models: a listed model by its permission, an unlisted one denied", async () => {
    const agent = agentFor();
    const { outcome } = await agent.decideModel("openai/gpt-5-mini", member);
    expect(outcome).toBe("granted");
    expect((await agent.decideModel("openai/gpt-5", member)).outcome).toBe(
      "denied",
    );
    expect((await agent.decideModel("openai/gpt-5", pro)).outcome).toBe(
      "granted",
    );
    expect((await agent.decideModel("other/model", pro)).outcome).toBe(
      "denied",
    );
    expect(
      (await agent.decideModel("openai/gpt-5-mini", { user: null })).outcome,
    ).toBe("denied");
    expect(await agent.permittedModels(member)).toStrictEqual([
      "openai/gpt-5-mini",
    ]);
    expect(await agent.permittedModels(pro)).toStrictEqual([
      "openai/gpt-5",
      "openai/gpt-5-mini",
    ]);
  });

  it("records the model on the decision event of the model gate", async () => {
    const sink = memoryDecisionSink();
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
      models,
      sink,
    });
    await agent.decideModel("openai/gpt-5", member);
    await agent.decideOperation("read_doc", { id: "d1" }, member);
    const [gate, operation] = sink.events();
    expect(gate).toMatchObject({
      type: "decision",
      outcome: "denied",
      permission: "model.use",
      model: "openai/gpt-5",
    });
    expect(parseSinkEvent(JSON.parse(JSON.stringify(gate)))).toStrictEqual(
      gate,
    );
    expect(operation).not.toHaveProperty("model");
  });

  it("without models, every model is denied and none is listed", async () => {
    const agent = agentFor(false);
    const { outcome } = await agent.decideModel("openai/gpt-5-mini", pro);
    expect(outcome).toBe("denied");
    expect(await agent.permittedModels(pro)).toStrictEqual([]);
  });

  it("filters results by the operation's results permission", async () => {
    const agent = agentFor();
    expect(
      await agent.filterResults("search_docs", rows, member),
    ).toStrictEqual([rows[0]]);
    expect(await agent.filterResults("search_docs", rows, pro)).toStrictEqual(
      rows,
    );
    expect(await agent.filterResults("read_doc", rows, member)).toStrictEqual(
      rows,
    );
    expect(await agent.filterResults("unknown", rows, pro)).toStrictEqual([]);
    expect(
      await agent.filterResults("search_docs", rows, { user: null }),
    ).toStrictEqual([]);
  });

  it("fails closed when the subject resolver throws", async () => {
    const agent = createPermDock(policy, {
      subject: (): User => {
        throw new Error("session store down");
      },
      operations,
      models,
    });
    const { outcome } = await agent.decideModel("openai/gpt-5-mini", {});
    expect(outcome).toBe("denied");
    expect(await agent.permittedModels({})).toStrictEqual([]);
    expect(await agent.filterResults("search_docs", rows, {})).toStrictEqual(
      [],
    );
  });

  it("returns gateway options with the principal and tags", async () => {
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
      actor: () => ({ id: "agent-1", kind: "agent" }),
      delegation: () => ({ scopes: ["doc:search"] }),
    });
    expect(await agent.gatewayOptions(member)).toStrictEqual({
      gateway: { user: "u1", tags: ["actor:agent"] },
    });
    expect(await agentFor().gatewayOptions({ user: null })).toStrictEqual({
      gateway: {},
    });
  });

  it("passes operation meta to approval policies", async () => {
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
      approvalPolicies: memoryApprovalPolicySource([
        { effects: ["read"], risk: ["low"], approval: "human" },
      ]),
    });
    const { outcome } = await agent.decideOperation("search_docs", {}, member);
    expect(outcome).toBe("approval-required");
    expect(
      (await agent.decideOperation("read_doc", { id: "d1" }, member)).outcome,
    ).toBe("granted");
  });

  it("gives tokenFor nothing for an unlisted operation", async () => {
    expect(await agentFor().tokenFor("nope", {}, member)).toBeUndefined();
  });
});

function userOf(context: { readonly [key: string]: unknown }): User | null {
  // SAFETY: every context in this file carries a User or null under `user`.
  return (context["user"] as User | null | undefined) ?? null;
}

describe("permdock/ai-sdk model gate", () => {
  const params = { tools: [{ name: "search_docs" }] };

  it("throws before the provider call for a model the subject lacks", async () => {
    const permdock = createAiSdk(policy, {
      subject: userOf,
      operations,
      models,
    });
    const middleware = permdock.capabilityMiddleware({ user: pro.user });
    await expect(
      middleware.transformParams({
        params,
        model: { modelId: "openai/gpt-5" },
      }),
    ).resolves.toStrictEqual(params);
    const denied = permdock.capabilityMiddleware({ user: member.user });
    await expect(
      denied.transformParams({ params, model: { modelId: "openai/gpt-5" } }),
    ).rejects.toMatchObject({
      name: "PermDockDeniedError",
      permission: "model.use",
    });
    await expect(
      denied.transformParams({ params, model: {} }),
    ).rejects.toMatchObject({ permission: "model" });
  });

  it("skips the model check without models", async () => {
    const permdock = createAiSdk(policy, { subject: userOf, operations });
    await expect(
      permdock
        .capabilityMiddleware({ user: member.user })
        .transformParams({ params, model: { modelId: "any/model" } }),
    ).resolves.toStrictEqual(params);
    expect(await permdock.gatewayOptions({ user: member.user })).toStrictEqual({
      gateway: { user: "u1" },
    });
  });
});
