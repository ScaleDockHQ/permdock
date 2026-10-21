import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ProtectedActionHandle } from "../../src/client/types.ts";
import type { ActionResult } from "../../src/core/action-result.ts";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { problemType } from "../../src/core/problem-types.ts";
import { useProtectedAction } from "../../src/react/protected-action.ts";
import { PermDockProvider } from "../../src/react/provider.tsx";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const approvalRequired: ActionResult<never> = {
  ok: false,
  problem: {
    type: problemType("approval-required"),
    title: "Approval required",
    status: 403,
    detail: "post.update needs an approval.",
    permission: "post.update",
    token: "pd1.token/one",
  },
};

describe(useProtectedAction, () => {
  beforeAll(() => {
    // SAFETY: React reads this global flag to allow act() outside a test renderer.
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  let root: Root | undefined;
  let host: HTMLElement | undefined;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
  });

  it("gates the control, keeps the result and retries with the approval token", async () => {
    // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
    const server = getPermDockSync(policy as never, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const calls: unknown[] = [];
    const answers: ActionResult<string>[] = [
      approvalRequired,
      { ok: true, value: "saved" },
    ];
    const action = (
      input: unknown,
      options?: { readonly approval?: string },
    ): Promise<ActionResult<string>> => {
      calls.push([input, options]);
      return Promise.resolve(answers.shift() ?? approvalRequired);
    };
    let handle: ProtectedActionHandle<string> | undefined;
    function Probe(): string {
      const current = useProtectedAction(
        action,
        permissions.post.update,
        ownPost,
      );
      handle = current;
      return `${current.gate.disabled}:${current.pending}:${current.result?.ok ?? "none"}:${current.approval?.token ?? "none"}`;
    }
    host = document.createElement("div");
    document.body.append(host);
    const created = createRoot(host);
    root = created;
    act(() => {
      created.render(
        createElement(PermDockProvider, {
          snapshot,
          endpoint: false,
          children: createElement(Probe),
        }),
      );
    });
    expect(host.textContent).toBe("false:false:none:none");
    await act(async () => {
      await handle?.run({ title: "Hello" });
    });
    expect(host.textContent).toBe("false:false:false:pd1.token/one");
    await act(async () => {
      await handle?.retry();
    });
    expect(host.textContent).toBe("false:false:true:none");
    expect(calls).toStrictEqual([
      [{ title: "Hello" }, undefined],
      [{ title: "Hello" }, { approval: "pd1.token/one" }],
    ]);
  });
});
