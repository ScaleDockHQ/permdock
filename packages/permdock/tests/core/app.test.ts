import { describe, expect, it } from "vitest";

import { createPermDock as createAgentPermDock } from "../../src/ai-sdk/index.ts";
import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { appOf } from "../../src/core/app.ts";
import {
  allow,
  getPermDockSync,
  defineApp,
  definePermissions,
  definePolicy,
  memoryDecisionSink,
  limits,
  memoryLimitStore,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read", "delete"], collection: ["create"] }),
});
const member = { id: "u1", roles: ["member"] };
const subject = (user: typeof member | null) => user;

const plain = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject,
});
const withApproval = definePolicy(permissions, {
  roles: [
    role("member", [allow(permissions.post.delete, { approval: "human" })]),
  ],
  subject,
});
const withLimit = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.create, { limit: { count: 1, per: 3600 } }),
    ]),
  ],
  subject,
});

describe(defineApp, () => {
  it("returns a policy that core and adapters read the app definition from", async () => {
    const sink = memoryDecisionSink();
    const app = defineApp(plain, { sink });
    expect(app.fingerprint).toBe(plain.fingerprint);
    expect(appOf(app)?.profile).toBe("prod");
    const permdock = getPermDockSync(app, member);
    expect(permdock.can(permissions.post.read, { id: "p1" })).toBe(true);
    expect(sink.events().length).toBeGreaterThan(0);
  });

  it("lets an option passed to getPermDockSync win over the app's", async () => {
    const appSink = memoryDecisionSink();
    const callSink = memoryDecisionSink();
    const permdock = getPermDockSync(
      defineApp(plain, { sink: appSink }),
      member,
      { sink: callSink },
    );
    permdock.can(permissions.post.read, { id: "p1" });
    expect(appSink.events()).toStrictEqual([]);
    expect(callSink.events().length).toBeGreaterThan(0);
  });

  it("throws under prod when a grant needs a store or limits the app lacks", () => {
    expect(() => defineApp(withApproval)).toThrow(/needs a store/u);
    expect(() => defineApp(withLimit)).toThrow(/needs limits/u);
    expect(() =>
      defineApp(withApproval, { store: memoryApprovalStore() }),
    ).not.toThrow();
    expect(() =>
      defineApp(withLimit, { limits: limits(memoryLimitStore()) }),
    ).not.toThrow();
  });

  it("fills in memory limits and one shared memory store under dev", async () => {
    const limited = defineApp(withLimit, { profile: "dev" });
    const permdock = getPermDockSync(limited, member);
    expect(permdock.decide(permissions.post.create).outcome).toBe("granted");
    expect(permdock.decide(permissions.post.create).outcome).toBe("denied");
    expect(appOf(limited)?.store).toBeDefined();

    const approvals = defineApp(withApproval, { profile: "dev" });
    const agent = createAgentPermDock(approvals, {
      subject: () => member,
      operations: { delete_post: { permission: permissions.post.delete } },
    });
    // SAFETY: the adapter reads only toolCall and messages from the AI SDK options.
    const first = await agent.toolApproval({
      toolCall: {
        toolName: "delete_post",
        toolCallId: "c1",
        input: { id: "p1" },
      },
      messages: [],
    } as never);
    expect(first).toMatchObject({ type: "user-approval" });
  });
});
