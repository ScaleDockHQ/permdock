import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/core/permdock.ts";
import { useDescribe, usePermission } from "../../src/solid/hooks.ts";
import { Protected } from "../../src/solid/protected.ts";
import { PermDockProvider } from "../../src/solid/provider.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

async function memberSnapshot() {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

function DescribeProbe(): string {
  const explain = useDescribe();
  const permission = usePermission(permissions.post.publish, () => ownPost);
  return explain(permission().decision).detail;
}

describe("permdock/solid provider defaults", () => {
  it("renders the approval slot, then denied, then provider defaults", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToString(() =>
      createComponent(PermDockProvider, {
        snapshot,
        defaults: { denied: "no" },
        messages: { reasons: { "no-grant": "Geen toegang" } },
        get children() {
          return [
            createComponent(Protected, {
              permission: permissions.post.delete,
              data: ownPost,
              approval: (decision) => `ask:${decision.reason}`,
              children: "delete",
            }),
            "|",
            createComponent(Protected, {
              permission: permissions.post.delete,
              data: ownPost,
              denied: "own",
              children: "delete",
            }),
            "|",
            createComponent(Protected, {
              permission: permissions.post.update,
              data: otherPost,
              children: "edit",
            }),
            "|",
            createComponent(DescribeProbe, {}),
          ];
        },
      }),
    );
    expect(html.replaceAll(/<!--.*?-->/gu, "")).toBe(
      "ask:human|own|no|Geen toegang",
    );
  });
});
