import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h, ref } from "vue";
import { renderToString } from "vue/server-renderer";

import { createPermDock } from "../../src/core/permdock.ts";
import { approvalHeaders } from "../../src/react/headers.ts";
import {
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from "../../src/vue/composables.ts";
import { permdockPlugin } from "../../src/vue/plugin.ts";
import { Protected } from "../../src/vue/protected.ts";
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

const Probe = defineComponent({
  setup() {
    const { allowed } = usePermission(permissions.post.update, ownPost);
    const actions = usePermissions(
      [permissions.post.update, permissions.post.publish],
      ownPost,
    );
    const editable = useFilter(permissions.post.update, [ownPost, otherPost]);
    const tenant = useTenant();
    const memberships = useMemberships();
    const roles = useRoles();
    const subject = useSubject();
    const permdock = usePermDock();
    return () =>
      `${allowed.value}:${actions.value.granted.length}:${editable.value.length}:${editable.value.partial}:${tenant.value.tenant ?? "none"}:${memberships.value.length}:${roles.value.roles.map((item) => item.key).join(",")}:${subject.value.simulated}:${permdock.status()}`;
  },
});

describe("permdock/vue", () => {
  it("renders portable grants from the snapshot without flashing deny", async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      setup() {
        return () =>
          h("div", [
            h(
              Protected,
              { permission: permissions.post.update, data: ownPost },
              { default: () => "edit", fallback: () => "locked" },
            ),
            h(
              Protected,
              { permission: permissions.post.update, data: otherPost },
              { default: () => "edit", fallback: () => "locked" },
            ),
          ]);
      },
    });
    app.use(permdockPlugin, { snapshot });
    const html = await renderToString(app);
    expect(html).toContain("edit");
    expect(html).toContain("locked");
  });

  it("exposes snapshot introspection through composables", async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      setup() {
        return () => h("span", [h(Probe)]);
      },
    });
    app.use(permdockPlugin, { snapshot });
    const html = await renderToString(app);
    expect(html).toContain("true:1:1:false");
    expect(html).toContain("member");
    expect(html).toContain("false:ready");
  });

  it("renders a snapshot held in reactive state (Nuxt useState)", async () => {
    const state = ref<unknown>(
      JSON.parse(JSON.stringify(await memberSnapshot())),
    );
    const app = createSSRApp({
      setup() {
        return () =>
          h(
            Protected,
            { permission: permissions.post.update, data: ownPost },
            { default: () => "edit", fallback: () => "locked" },
          );
      },
    });
    // SAFETY: state holds a JSON round-trip of a real snapshot, as Nuxt useState would.
    app.use(permdockPlugin, { snapshot: () => state.value as never });
    await expect(renderToString(app)).resolves.toContain("edit");
  });

  it("builds the approval resume header", () => {
    expect(approvalHeaders("pd1.abc")).toEqual({
      "PermDock-Approval": "pd1.abc",
    });
  });
});
