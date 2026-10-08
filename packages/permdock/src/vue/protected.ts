import {
  computed,
  defineComponent,
  type DefineComponent,
  type PropType,
  type VNode,
} from "vue";

import type { Permission } from "../core/permissions.ts";

import { protectedView } from "../client/views.ts";
import { usePermission, usePermDock } from "./composables.ts";

export type ProtectedProps = {
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
      // SAFETY: Vue's PropType idiom; `null` skips the runtime type check, so a row of any type passes.
      type: null as unknown as PropType<unknown>,
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
    const scoped = computed(() =>
      props.tenant === undefined ? undefined : root.tenant(props.tenant),
    );
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
        scoped.value,
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
