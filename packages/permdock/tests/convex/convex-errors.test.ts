import { describe, expect, it } from "vitest";

import { ConvexError, createPermDock } from "../../src/convex/index.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("permdock/convex errors and registration", () => {
  it("maps approval-required to a ConvexError and passes other errors on", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const remove = withPermDock((ctx) => {
      ctx.permdock.assert(permissions.post.delete, ownPost);
    });
    const boom = new Error("boom");
    const crash = withPermDock(() => {
      throw boom;
    });
    await expect(remove({}, {})).rejects.toBeInstanceOf(ConvexError);
    await expect(remove({}, {})).rejects.toMatchObject({
      data: { status: 403, permission: "post.delete" },
    });
    await expect(crash({}, {})).rejects.toBe(boom);
  });

  it("registers snapshotQuery through the supplied query builder", async () => {
    const registered: unknown[] = [];
    const { snapshotQuery } = createPermDock(policy, {
      subject: () => memberUser,
      query: (definition) => {
        registered.push(definition);
        return { registered: true };
      },
    });
    expect(snapshotQuery()).toEqual({ registered: true });
    expect(registered.length).toBe(1);
  });
});
