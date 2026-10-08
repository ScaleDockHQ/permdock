<script lang="ts">
  import type { Snapshot } from 'permdock';

  import {
    PermissionBoundary,
    Protected,
    permission,
    setPermDock,
  } from 'permdock/svelte';

  import { ownPost, permissions } from './permissions.ts';
  import PublishPanel from './publish-panel.svelte';

  let { snapshot }: { snapshot: Snapshot } = $props();
  const initial = snapshot;
  setPermDock({ snapshot: initial });

  const canDelete = permission(permissions.post.delete, () => ownPost);
</script>

<Protected permission={permissions.post.update} data={ownPost}>
  <span>edit</span>
  {#snippet fallback()}<span>locked</span>{/snippet}
</Protected>
{#if $canDelete.allowed}
  <button type="button">delete</button>
{:else}
  <span
    >{$canDelete.decision.outcome === 'approval-required'
      ? 'ask to delete'
      : 'locked'}</span
  >
{/if}
<PermissionBoundary>
  <PublishPanel />
  {#snippet denied(refused)}<span>no {refused.permission}</span>{/snippet}
</PermissionBoundary>
