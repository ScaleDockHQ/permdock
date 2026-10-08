<script lang="ts">
  import type { PermissionBoundaryState } from '../../src/svelte/runtime.ts';

  import PermissionBoundary from '../../src/svelte/PermissionBoundary.svelte';
  import Thrower from './Thrower.test.svelte';

  let {
    digest,
    onstate,
  }: {
    digest: () => string | null;
    onstate: (state: PermissionBoundaryState) => void;
  } = $props();
</script>

<svelte:boundary>
  <PermissionBoundary>
    <Thrower {digest} />
    {#snippet denied(state)}
      {onstate(state)}denied {state.permission}
    {/snippet}
    {#snippet approval(state)}
      {onstate(state)}approval {state.outcome === 'approval-required'
        ? state.token
        : ''}
    {/snippet}
  </PermissionBoundary>
  {#snippet failed(error)}
    outer {error instanceof Error ? error.message : ''}
  {/snippet}
</svelte:boundary>
