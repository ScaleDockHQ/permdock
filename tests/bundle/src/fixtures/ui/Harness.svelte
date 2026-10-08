<script lang="ts">
  import type { Permission, Snapshot } from 'permdock';

  import {
    PermissionBoundary,
    Protected,
    requiredPlans,
    setPermDock,
  } from 'permdock/svelte';

  let {
    snapshot,
    granted,
    denied,
  }: { snapshot: Snapshot; granted: Permission; denied: Permission } =
    $props();

  // svelte-ignore state_referenced_locally
  setPermDock({ snapshot });
</script>

<s>{typeof requiredPlans}</s>
<PermissionBoundary>
<Protected permission={granted}>
  {#snippet children()}<b>granted</b>{/snippet}
  {#snippet fallback()}<i>denied</i>{/snippet}
</Protected>
<Protected permission={denied}>
  {#snippet children()}<b>granted</b>{/snippet}
  {#snippet fallback()}<i>denied</i>{/snippet}
</Protected>
</PermissionBoundary>
