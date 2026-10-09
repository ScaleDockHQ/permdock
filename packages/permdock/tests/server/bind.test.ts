import { describe, expect, it } from "vitest";

import { bindKernel } from "../../src/server/bind.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

type Context = { readonly url: string; readonly tenant?: string };

const toRequest = (context: Context): Request => new Request(context.url);

describe("bindKernel", () => {
  it("reads the subject from the context a request was bound to", async () => {
    let calls = 0;
    const { kernel, bind } = bindKernel(
      policy,
      {
        subject: () => {
          calls += 1;
          return memberUser;
        },
      },
      "test",
      toRequest,
    );
    const context: Context = { url: "http://localhost/" };
    const request = bind(context);
    expect(bind(context)).toBe(request);
    const instance = await kernel.permdock(request);
    expect(instance.can(permissions.post.list)).toBe(true);
    expect(calls).toBe(1);
  });

  it("treats a request it never bound as anonymous with no tenant", async () => {
    const { kernel, handlerScope } = bindKernel(
      policy,
      {
        subject: () => memberUser,
        tenant: (context: Context) => context.tenant,
      },
      "test",
      toRequest,
    );
    const stray = new Request("http://localhost/");
    expect(await handlerScope(stray)).toEqual({ tenant: undefined });
    expect((await kernel.permdock(stray)).can(permissions.post.list)).toBe(
      false,
    );
  });

  it("shares the resolved subject with a rebound request", async () => {
    let calls = 0;
    const { kernel, bind, rebind } = bindKernel(
      policy,
      {
        subject: () => {
          calls += 1;
          return memberUser;
        },
      },
      "test",
      toRequest,
    );
    const context: Context = { url: "http://localhost/" };
    await kernel.permdock(bind(context));
    const again = rebind(context);
    expect(again).not.toBe(bind(context));
    await kernel.permdock(again);
    expect(calls).toBe(1);
  });
});
