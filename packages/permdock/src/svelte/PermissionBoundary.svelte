<script lang="ts">
  import {
    boundaryDigest,
    type PermissionBoundaryProps,
    type PermissionBoundaryState,
  } from './runtime.ts';

  let { children, denied, approval }: PermissionBoundaryProps = $props();

  let refused = $state<PermissionBoundaryState | null>(null);

  // A rethrown error reaches the next boundary up.
  function onerror(error: unknown, reset: () => void): void {
    const digest = boundaryDigest(error);
    if (digest === null) {
      throw error;
    }
    refused = {
      ...digest,
      retry: (): void => {
        refused = null;
        reset();
      },
    };
  }
</script>

<svelte:boundary {onerror}>
  {@render children?.()}
  {#snippet failed()}
    {#if refused !== null}
      {@const fallback =
        refused.outcome === 'approval-required' ? (approval ?? denied) : denied}
      {@render fallback?.(refused)}
    {/if}
  {/snippet}
</svelte:boundary>
