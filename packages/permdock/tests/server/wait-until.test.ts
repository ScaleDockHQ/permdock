import { describe, expect, it } from "vitest";

import type { DecisionSink } from "../../src/index.ts";

import { createPermDock } from "../../src/server/index.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

const token = {
  principal: { id: "u1", orgId: "o1", roles: ["member"], memberships: [] },
  context: {},
};

function bufferedSink() {
  const calls: string[] = [];
  const sink: DecisionSink = {
    write(events) {
      calls.push(`write ${events.length}`);
      return Promise.resolve();
    },
    flush() {
      calls.push("flush");
      return Promise.resolve();
    },
  };
  return { sink, calls };
}

describe("server kit waitUntil", () => {
  it("hands every write and one flush per tick to waitUntil", async () => {
    const { sink, calls } = bufferedSink();
    const kept: Promise<unknown>[] = [];
    const kernel = createPermDock(policy, {
      subject: () => token,
      sink,
      waitUntil: (task) => {
        kept.push(task);
      },
    });
    const permdock = await kernel.getPermDock(new Request("https://app.test/"));
    permdock.can(permissions.post.list);
    permdock.can(permissions.post.list);
    expect(kept).toHaveLength(3);
    await Promise.all(kept);
    expect(calls).toStrictEqual(["write 1", "write 1", "flush"]);
  });

  it("still decides when waitUntil throws", async () => {
    const { sink, calls } = bufferedSink();
    const kernel = createPermDock(policy, {
      subject: () => token,
      sink,
      waitUntil: () => {
        throw new Error("outside a request");
      },
    });
    const permdock = await kernel.getPermDock(new Request("https://app.test/"));
    expect(permdock.can(permissions.post.list)).toBe(true);
    expect(calls).toStrictEqual(["write 1"]);
  });
});
