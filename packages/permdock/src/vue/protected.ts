import {
  defineComponent,
  type DefineComponent,
  type PropType,
  type VNode,
} from 'vue';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { ClientStatus } from './types.ts';

import { usePermission, usePermDock } from './composables.ts';

type ScopedView = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
};

type DecideDock = {
  readonly decide: (permission: Permission, data?: unknown) => Decision;
};

type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
};

export const Protected: DefineComponent<ProtectedProps> = defineComponent({
  name: 'Protected',
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
      // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
      const scoped: ScopedView =
        props.tenant === undefined
          ? {
              allowed: local.allowed.value,
              status: local.status.value,
              decision: local.decision.value,
            }
          : tenantView(
              root.tenant(props.tenant) as DecideDock,
              props.permission,
              props.data,
            );
      if (scoped.status === 'pending') {
        return slots['pending']?.() ?? null;
      }
      if (!scoped.allowed || scoped.decision.outcome !== 'granted') {
        return slots['fallback']?.({ decision: scoped.decision }) ?? null;
      }
      return slots['default']?.({ decision: scoped.decision }) ?? null;
    };
  },
});

function tenantView(
  dock: DecideDock,
  permission: Permission,
  data: unknown,
): ScopedView {
  const decision = dock.decide(permission, data);
  return {
    allowed: decision.outcome === 'granted',
    status: 'ready',
    decision,
  };
}
