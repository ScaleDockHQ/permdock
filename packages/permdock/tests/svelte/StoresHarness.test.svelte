<script lang="ts">
  import type { Decision } from '../../src/core/decision.ts';
  import type { PermDockSvelteOptions } from '../../src/svelte/types.ts';

  import {
    approval,
    assignable,
    assignablePermissions,
    filtered,
    getPermDock,
    memberships,
    permission,
    permissions,
    roles,
    setPermDock,
    subject,
    tenant,
  } from '../../src/svelte/stores.ts';
  import {
    otherPost,
    ownPost,
    permissions as defs,
  } from '../fixtures/quick-start.ts';

  let {
    options,
    decision,
    onReady,
  }: {
    options?: PermDockSvelteOptions;
    decision: Decision;
    onReady: (value: unknown) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  if (options !== undefined) {
    setPermDock(options);
  }
  // svelte-ignore state_referenced_locally
  try {
    onReady({
      permdock: getPermDock(),
      permission: permission(defs.post.update, () => ownPost),
      permissions: permissions(
        () => [defs.post.update, defs.post.publish],
        () => ownPost,
      ),
      filtered: filtered(defs.post.update, () => [ownPost, otherPost]),
      tenant: tenant(),
      memberships: memberships(),
      roles: roles(),
      tenantRoles: roles(() => ({ tenant: 'o1' })),
      teamRoles: roles(() => ({ team: 'no-such-team' })),
      assignable: assignable(),
      assignablePermissions: assignablePermissions(),
      subject: subject(),
      approval: approval(() => decision),
    });
  } catch (error) {
    onReady(error);
  }
</script>
