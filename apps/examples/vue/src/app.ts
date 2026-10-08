import {
  PermissionBoundary,
  Protected,
  usePermDock,
  usePermission,
} from "permdock/vue";
import { defineComponent, h, type VNode } from "vue";

import { ownPost, permissions } from "./permissions.ts";

function useDeleteButton(): () => VNode {
  const { allowed, decision } = usePermission(permissions.post.delete, ownPost);
  return () => {
    if (allowed.value) {
      return h("button", { type: "button" }, "delete");
    }
    return h(
      "span",
      decision.value.outcome === "approval-required"
        ? "ask to delete"
        : "locked",
    );
  };
}

function usePublishPanel(): () => VNode {
  const permdock = usePermDock();
  return () => {
    permdock.assert(permissions.post.publish, ownPost);
    return h("span", "publish panel");
  };
}

const DeleteButton = defineComponent({
  name: "DeleteButton",
  setup: useDeleteButton,
});

const PublishPanel = defineComponent({
  name: "PublishPanel",
  setup: usePublishPanel,
});

export const App = defineComponent({
  name: "App",
  setup() {
    return () => [
      h(
        Protected,
        { permission: permissions.post.update, data: ownPost },
        {
          default: () => h("span", "edit"),
          fallback: () => h("span", "locked"),
        },
      ),
      h(DeleteButton),
      h(PermissionBoundary, null, {
        default: () => h(PublishPanel),
        denied: ({ permission }: { permission: string }) =>
          h("span", `no ${permission}`),
      }),
    ];
  },
});
