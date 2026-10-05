import { describe, expect, it } from "vitest";

import { approvalTokenOf, createAgentKernel } from "../../src/agent/kernel.ts";
import { boundedMap } from "../../src/agent/lru.ts";
import { modelReason } from "../../src/agent/reason.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("boundedMap", () => {
  it("evicts the least recently used key past the limit", () => {
    const map = boundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect({
      a: map.get("a"),
      b: map.get("b"),
      c: map.get("c"),
      size: map.size(),
    }).toEqual({ a: 1, b: undefined, c: 3, size: 2 });
    map.delete("a");
    expect({
      a: map.get("a"),
      missing: map.get("zz"),
      size: map.size(),
    }).toEqual({ a: undefined, missing: undefined, size: 1 });
  });
});

describe("approvalTokenOf", () => {
  it("reads only a non-empty string token from an object", () => {
    expect(
      [
        { permdockApproval: "tok" },
        { permdockApproval: "" },
        { permdockApproval: 7 },
        {},
        null,
        "tok",
      ].map((context) => approvalTokenOf(context)),
    ).toEqual(["tok", undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("modelReason", () => {
  it("names an unknown permission in a denial", () => {
    expect(
      modelReason(
        {
          outcome: "denied",
          denials: [{ role: null, reason: "no-grant" }],
          alternatives: [],
        },
        undefined,
        undefined,
      ),
    ).toContain("unknown");
  });
});

describe("createAgentKernel edge cases", () => {
  const tools = {
    delete_post: {
      permission: permissions.post.delete,
      data: (args: unknown) => (args === "missing" ? undefined : ownPost),
    },
    list_posts: { permission: permissions.post.list },
    explode: {
      permission: permissions.post.update,
      data: () => {
        throw new Error("loader failed");
      },
    },
  };

  it("drops an actor that is not an object with string id and kind", async () => {
    const actors: unknown[] = [
      null,
      ["agent"],
      { id: 1, kind: "x" },
      { id: "a", kind: 2 },
    ];
    const seen = [];
    for (const value of actors) {
      const kernel = createAgentKernel(policy, {
        adapter: "test",
        subject: () => memberUser,
        actor: () => value,
        tools,
      });
      seen.push((await kernel.instance({})).subject.actor);
    }
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("passes a delegation through and drops a throwing one", async () => {
    const delegated = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      delegation: () => ({ scopes: ["post:list"] }),
      tools,
    });
    const broken = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      delegation: () => {
        throw new Error("no delegation");
      },
      tools,
    });
    expect({
      delegated: (await delegated.instance({})).subject.delegation,
      broken: (await broken.instance({})).subject.delegation,
    }).toEqual({ delegated: { scopes: ["post:list"] }, broken: undefined });
  });

  it("builds a fresh instance for a primitive context", async () => {
    let reads = 0;
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => {
        reads += 1;
        return memberUser;
      },
      tools,
    });
    await kernel.instance("ctx");
    await kernel.instance("ctx");
    expect(reads).toBe(2);
  });

  it("computes the approval token without touching a store", async () => {
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      tools,
    });
    const token = await kernel.tokenFor(tools.delete_post, {}, {});
    expect({
      approval: typeof token,
      missing: await kernel.tokenFor(tools.delete_post, "missing", {}),
      granted: await kernel.tokenFor(tools.list_posts, {}, {}),
      thrown: await kernel.tokenFor(tools.explode, {}, {}),
    }).toEqual({
      approval: "string",
      missing: undefined,
      granted: undefined,
      thrown: undefined,
    });
  });
});

describe("createAgentKernel check", () => {
  const update = {
    permission: permissions.post.update,
    data: (): unknown => ownPost,
  };

  it("returns the instance, the row and the decision", async () => {
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
    });
    const checked = await kernel.check(update, {}, {});
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.data).toBe(ownPost);
      expect(checked.decision.outcome).toBe("granted");
      expect(checked.permdock.subject.principal?.id).toBe(memberUser.id);
    }
  });

  it("names the failure and keeps the instance once it was built", async () => {
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
    });
    const thrown = await kernel.check(
      {
        permission: permissions.post.update,
        data: () => {
          throw new Error("store down");
        },
      },
      {},
      {},
    );
    expect(thrown).toMatchObject({ ok: false, failure: "load-failed" });
    expect(thrown.permdock?.subject.principal?.id).toBe(memberUser.id);

    const missing = await kernel.check(
      { permission: permissions.post.update, data: () => null },
      {},
      {},
    );
    expect(missing).toMatchObject({ ok: false, failure: "no-data" });

    const collection = await kernel.check(
      { permission: permissions.post.list, data: () => null },
      {},
      {},
    );
    expect(collection.ok).toBe(true);
  });

  it("fails without an instance when wrap throws", async () => {
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      wrap: () => {
        throw new Error("tracer down");
      },
    });
    const checked = await kernel.check(update, {}, {});
    expect(checked).toEqual({ ok: false, failure: "failed" });
  });

  it("decides on the wrapped instance", async () => {
    const wrapped: unknown[] = [];
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      wrap: (instance) => {
        wrapped.push(instance);
        return instance;
      },
    });
    const checked = await kernel.check(update, {}, {});
    expect(wrapped).toHaveLength(1);
    expect(checked.permdock).toBe(wrapped[0]);
  });

  it("records an adapter check and leaves a simulated one out of the sink", async () => {
    const sources: unknown[] = [];
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      sink: {
        write: (events) => {
          for (const event of events) {
            if (event.type === "decision") {
              sources.push(event.source);
            }
          }
        },
      },
    });
    await kernel.check(update, {}, {}, { simulate: true });
    await kernel.check(update, {}, {});
    expect(sources).toEqual(["adapter"]);
  });
});
