import type { Component } from 'svelte';

import type { ProtectedProps } from './protected.ts';

// Kept as source: the app's Svelte compiler builds it for SSR or the client.
import ProtectedComponent from './Protected.svelte';

export { describe } from '../core/describe.ts';
export { approvalHeaders } from '../react/headers.ts';
export { setPermDock } from './stores.ts';
export {
  approval,
  assignable,
  filtered,
  getPermDock,
  memberships,
  permission,
  permissions,
  roles,
  subject,
  tenant,
} from './stores.ts';
export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermDockSvelteOptions,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from './types.ts';

export type { ProtectedProps } from './protected.ts';

export const Protected: Component<ProtectedProps> = ProtectedComponent;
