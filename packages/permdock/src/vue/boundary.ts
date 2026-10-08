import {
  defineComponent,
  inject,
  onErrorCaptured,
  provide,
  shallowRef,
  type DefineComponent,
  type InjectionKey,
  type ShallowRef,
  type VNode,
} from "vue";

import type { PermissionBoundaryState } from "../client/boundary.ts";

import { boundaryDigest } from "../client/boundary.ts";

const boundaryKey: InjectionKey<ShallowRef<PermissionBoundaryState | null>> =
  Symbol("permdock-boundary");

/**
 * Catches `PermDockDeniedError` and `PermDockApprovalRequiredError` thrown
 * by a descendant and renders the `denied` slot, or the `approval` slot for
 * an approval request (default `denied`). The slots receive the refused
 * permission and `retry()`. Any other error propagates.
 */
export const PermissionBoundary: DefineComponent = defineComponent({
  name: "PermissionBoundary",
  setup(_props, { slots }): () => VNode | VNode[] | null {
    const state = shallowRef<PermissionBoundaryState | null>(null);
    provide(boundaryKey, state);
    onErrorCaptured((error): false | undefined => {
      const digest = boundaryDigest(error);
      if (digest === null) {
        return undefined;
      }
      state.value = {
        ...digest,
        retry: (): void => {
          state.value = null;
        },
      };
      return false;
    });
    return (): VNode | VNode[] | null => {
      const current = state.value;
      if (current === null) {
        return slots["default"]?.() ?? null;
      }
      const slot =
        current.outcome === "approval-required"
          ? (slots["approval"] ?? slots["denied"])
          : slots["denied"];
      return slot?.(current) ?? null;
    };
  },
});

/** Inside a `PermissionBoundary`: what was refused and `retry()`, or `null` while the children render. */
export function usePermissionBoundary(): PermissionBoundaryState | null {
  return inject(boundaryKey, null)?.value ?? null;
}
