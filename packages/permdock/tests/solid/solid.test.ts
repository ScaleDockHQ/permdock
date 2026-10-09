import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import { approvalHeaders } from "../../src/client/headers.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from "../../src/solid/hooks.ts";
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
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

function Probe(): string {
  const allowed = usePermission(permissions.post.update, () => ownPost);
  const actions = usePermissions(
    () => [permissions.post.update, permissions.post.publish],
    () => ownPost,
  );
  const editable = useFilter(permissions.post.update, () => [
    ownPost,
    otherPost,
  ]);
  const tenant = useTenant();
  const memberships = useMemberships();
  const roles = useRoles();
  const subject = useSubject();
  const permdock = usePermDock();
  return `${allowed().allowed}:${actions().granted.length}:${editable().length}:${editable().partial}:${tenant().tenant ?? "none"}:${memberships().length}:${roles()
    .roles.map((item) => item.key)
    .join(",")}:${subject().simulated}:${permdock.status()}`;
}

describe("permdock/solid", () => {
  it("renders portable grants from the snapshot without flashing deny", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToString(() =>
      createComponent(PermDockProvider, {
        snapshot,
        get children() {
          return [
            createComponent(Protected, {
              permission: permissions.post.update,
              data: ownPost,
              fallback: "locked",
              children: "edit",
            }),
            createComponent(Protected, {
              permission: permissions.post.update,
              data: otherPost,
              fallback: "locked",
              children: "edit",
            }),
          ];
        },
      }),
    );
    expect(html).toContain("edit");
    expect(html).toContain("locked");
  });

  it("exposes snapshot introspection through accessors", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToString(() =>
      createComponent(PermDockProvider, {
        snapshot,
        get children() {
          return createComponent(Probe, {});
        },
      }),
    );
    expect(html).toContain("true:1:1:false");
    expect(html).toContain("member");
    expect(html).toContain("false:ready");
  });

  it("builds the approval resume header", () => {
    expect(approvalHeaders("pd1.abc")).toEqual({
      "PermDock-Approval": "pd1.abc",
    });
  });
});
