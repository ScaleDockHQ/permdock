import {
  defineComponent,
  type DefineComponent,
  type PropType,
  type VNode,
} from "vue";

import type { Permission } from "../core/permissions.ts";

import { protectedView } from "../client/views.ts";
import { usePermission, usePermDock } from "./composables.ts";

type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
};

export const Protected: DefineComponent<ProtectedProps> = defineComponent({
  name: "Protected",
  props: {
    permission: {
      // SAFETY: Vue's PropType idiom; the runtime check is Object and the static type a permission leaf.
      type: Object as PropType<Permission>,
      required: true,
    },
    data: {
      // SAFETY: Vue's PropType idiom; unknown is the widest static type for any row.
      type: Object as PropType<unknown>,
      required: false,
    },
    tenant: {
      type: String,
      required: false,
    },
  },
  setup(props, { slots }): () => VNode | VNode[] | string | null {
    const local = usePermission(
      () => props.permission,
      () => props.data,
    );
    const root = usePermDock();
    return (): VNode | VNode[] | string | null => {
      const view = protectedView(
        {
          allowed: local.allowed.value,
          status: local.status.value,
          decision: local.decision.value,
        },
        root,
        props.permission,
        props.data,
        props.tenant,
      );
      switch (view.slot) {
        case "pending":
          return slots["pending"]?.() ?? null;
        case "fallback":
          return slots["fallback"]?.({ decision: view.decision }) ?? null;
        case "default":
          return slots["default"]?.({ decision: view.decision }) ?? null;
        default: {
          const exhausted: never = view;
          return exhausted;
        }
      }
    };
  },
});
