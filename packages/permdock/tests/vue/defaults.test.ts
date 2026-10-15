import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";

import { createPermDock } from "../../src/core/permdock.ts";
import { useDescribe, usePermission } from "../../src/vue/composables.ts";
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
  const server = createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

const DescribeProbe = defineComponent({
  setup() {
    const explain = useDescribe();
    const { decision } = usePermission(permissions.post.publish, ownPost);
    return () => explain(decision.value).detail;
  },
});

describe("permdock/vue plugin defaults", () => {
  it("renders the approval slot, then denied, then plugin defaults", async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      setup() {
        return () =>
          h("div", [
            h(
              Protected,
              { permission: permissions.post.delete, data: ownPost },
              {
                default: () => "delete",
                approval: ({ decision }: { decision: { reason: string } }) =>
                  `ask:${decision.reason}`,
              },
            ),
            "|",
            h(
              Protected,
              { permission: permissions.post.delete, data: ownPost },
              { default: () => "delete", denied: () => "own" },
            ),
            "|",
            h(
              Protected,
              { permission: permissions.post.update, data: otherPost },
              { default: () => "edit" },
            ),
            "|",
            h(DescribeProbe),
          ]);
      },
    });
    app.use(permdockPlugin, {
      snapshot,
      defaults: { denied: () => "no" },
      messages: { reasons: { "no-grant": "Geen toegang" } },
    });
    const html = await renderToString(app);
    expect(html.replaceAll(/<!--.*?-->/gu, "")).toBe(
      "<div>ask:human|own|no|Geen toegang</div>",
    );
  });
});
