import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/a2a/create.ts";
import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const card = {
  name: "Posts agent",
  url: "https://agent.example.com/a2a",
  version: "1.0.0",
};

const securitySchemes = {
  oauth: {
    type: "oauth2",
    oauth2MetadataUrl:
      "https://auth.example.com/.well-known/oauth-authorization-server",
  },
} as const;

const skills = {
  summarise: {
    permission: permissions.post.read,
    description: "Summarise a post",
    data: async () => ownPost,
  },
  publish: {
    permission: permissions.post.publish,
    data: async () => ownPost,
  },
};

describe("permdock/a2a", () => {
  it("emits every skill and its scope on the public card", () => {
    const { agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills,
    });
    const published = agentCard();
    expect(published.supportedInterfaces[0]?.protocolVersion).toBe("1.0");
    expect(published.skills.map((skill) => skill.id)).toEqual([
      "summarise",
      "publish",
    ]);
    expect(published.skills[0]?.securityRequirements).toEqual([
      { schemes: { oauth: { list: [permissions.post.read.scope] } } },
    ]);
    expect(published.skills[1]?.securityRequirements).toEqual([
      { schemes: { oauth: { list: [permissions.post.publish.scope] } } },
    ]);
  });

  it("filters the extended card by the caller grants", async () => {
    const { extendedAgentCard } = createPermDock(policy, {
      subject: (auth) => (auth.clientId === "admin" ? adminUser : memberUser),
      card,
      securitySchemes,
      skills,
    });
    const memberCard = await extendedAgentCard({
      clientId: "member",
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    });
    expect(memberCard.skills.map((skill) => skill.id)).toEqual(["summarise"]);
    const adminCard = await extendedAgentCard({
      clientId: "admin",
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    });
    expect(adminCard.skills.map((skill) => skill.id)).toEqual([
      "summarise",
      "publish",
    ]);
  });

  it("never reads identity from the task body", async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: (auth) => (auth.clientId === "admin" ? adminUser : null),
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill((task) => {
      if (
        task !== null &&
        typeof task === "object" &&
        "skillId" in task &&
        typeof task.skillId === "string"
      ) {
        return task.skillId;
      }
      return "";
    });
    const forged = await run(
      { skillId: "publish", user: adminUser },
      { clientId: "forged", scopes: [permissions.post.publish.scope] },
    );
    expect(forged.ok).toBe(false);
    if (forged.ok) {
      return;
    }
    expect(forged.status).toBe(403);
  });

  it("rejects a task when the token is missing the skill scope", async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill(() => "publish");
    const result = await run({ skillId: "publish" }, { clientId: "admin" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(401);
    expect(result.wwwAuthenticate).toContain("insufficient_scope");
    expect(result.wwwAuthenticate).toContain(permissions.post.publish.scope);
  });

  it("returns problem details for a denied skill and input-required for approval", async () => {
    const factory = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills: {
        ...skills,
        remove: {
          permission: permissions.post.delete,
          data: async () => ownPost,
        },
      },
    });
    const run = factory.protectSkill((task) => {
      if (
        task !== null &&
        typeof task === "object" &&
        "skillId" in task &&
        typeof task.skillId === "string"
      ) {
        return task.skillId;
      }
      return "";
    });
    const denied = await run(
      { skillId: "publish" },
      { scopes: [permissions.post.publish.scope] },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.state).toBe("failed");
    expect(denied.problem.type).toContain("/denied");
    const approval = await run(
      { skillId: "remove" },
      { scopes: [permissions.post.delete.scope] },
    );
    expect(approval.ok).toBe(false);
    if (approval.ok) {
      return;
    }
    expect(approval.state).toBe("input-required");
    expect(approval.problem.type).toContain("/approval-required");
    expect(approval.problem.token).toEqual(expect.any(String));
  });

  it("runs a granted skill and signs a card payload", async () => {
    const { protectSkill, sign, agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill(() => "summarise");
    const granted = await run(
      { skillId: "summarise" },
      { scopes: [permissions.post.read.scope] },
    );
    expect(granted).toEqual({ ok: true });
    const signed = await sign(
      agentCard(),
      async (payload) =>
        `eyJhbGciOiJ0ZXN0In0.${Buffer.from(payload).toString("base64url")}.c2ln`,
    );
    expect(signed.signatures).toEqual([
      { protected: "eyJhbGciOiJ0ZXN0In0", signature: "c2ln" },
    ]);
    expect(signed.name).toBe("Posts agent");
    await expect(sign(agentCard(), async () => "a.b.c")).rejects.toThrow(
      /compact JWS over the payload/u,
    );
  });

  it("refuses an instance skill without a data loader", () => {
    expect(() =>
      createPermDock(policy, {
        subject: () => memberUser,
        card,
        securitySchemes,
        skills: { summarise: { permission: permissions.post.read } },
      }),
    ).toThrow(/data loader/u);
  });

  it("validates the loaded row instead of trusting the task body", async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes,
      skills: {
        publish: {
          permission: permissions.post.publish,
          // SAFETY: both runs below pass a task object with a post; the row is then validated.
          data: async (task) => (task as { readonly post: unknown }).post,
        },
      },
    });
    const run = protectSkill(() => "publish");
    const scopes = { scopes: [permissions.post.publish.scope] };
    const forged = await run(
      { post: { id: "p2", authorId: "u9", orgId: "o1" } },
      scopes,
    );
    expect(forged.ok).toBe(false);
    expect(await run({ post: ownPost }, scopes)).toEqual({ ok: true });
  });

  it("denies when the data loader throws or finds nothing", async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes,
      skills: {
        boom: {
          permission: permissions.post.publish,
          data: async () => {
            throw new Error("db down");
          },
        },
        gone: { permission: permissions.post.publish, data: async () => null },
      },
    });
    const scopes = { scopes: [permissions.post.publish.scope] };
    expect((await protectSkill(() => "boom")({}, scopes)).ok).toBe(false);
    expect((await protectSkill(() => "gone")({}, scopes)).ok).toBe(false);
  });

  it("treats prototype names as unknown skills", async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes,
      skills,
    });
    for (const id of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      const outcome = await protectSkill(() => id)({}, { scopes: [] });
      expect(outcome).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("parks an approval in the store and resumes it once, on any instance", async () => {
    const store = memoryApprovalStore();
    const options = {
      subject: () => memberUser,
      card,
      securitySchemes,
      store,
      skills: {
        remove: {
          permission: permissions.post.delete,
          data: async () => ownPost,
        },
      },
    };
    const auth = {
      clientId: "agent-1",
      scopes: [permissions.post.delete.scope],
    };
    const parked = await createPermDock(policy, options).protectSkill(
      () => "remove",
    )({}, auth);
    if (parked.ok) {
      throw new Error("expected approval-required");
    }
    const token = parked.problem.token;
    expect(token).toEqual(expect.any(String));
    expect(await store.get(String(token))).toMatchObject({ status: "pending" });

    const again = await createPermDock(policy, options).protectSkill(
      () => "remove",
    )({}, auth);
    expect(again).toMatchObject({ ok: false, state: "input-required" });

    await resolveApproval(store, String(token), {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });
    const run = createPermDock(policy, options).protectSkill(() => "remove");
    expect(await run({}, auth)).toEqual({ ok: true });
    expect(await run({}, auth)).toMatchObject({ ok: false, state: "failed" });
  });

  it("ignores an approval token for another client", async () => {
    const store = memoryApprovalStore();
    const options = {
      subject: () => memberUser,
      card,
      securitySchemes,
      store,
      skills: {
        remove: {
          permission: permissions.post.delete,
          data: async () => ownPost,
        },
      },
    };
    const scopes = [permissions.post.delete.scope];
    const run = createPermDock(policy, options).protectSkill(() => "remove");
    const parked = await run({}, { clientId: "agent-1", scopes });
    if (parked.ok) {
      throw new Error("expected approval-required");
    }
    await resolveApproval(store, String(parked.problem.token), {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });
    const other = await run(
      {},
      {
        clientId: "agent-2",
        scopes,
        extra: { approval: String(parked.problem.token) },
      },
    );
    expect(other).toMatchObject({ ok: false, state: "input-required" });
  });
});
