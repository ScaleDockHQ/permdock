<script lang="ts">
  import { onDestroy } from 'svelte';

  import { getStore } from './context.ts';
  import { protectedView, type ProtectedProps } from './protected.ts';

  let {
    permission,
    data,
    tenant,
    children,
    pending,
    fallback,
  }: ProtectedProps = $props();

  const store = getStore();
  let tick = $state(0);
  onDestroy(
    store.subscribe(() => {
      tick += 1;
    }),
  );
  const view = $derived.by(() => {
    const generation = tick;
    return protectedView(store, permission, data, tenant, generation);
  });
</script>

{#if view.slot === 'pending'}
  {@render pending?.()}
{:else if view.slot === 'fallback'}
  {@render fallback?.(view.decision)}
{:else}
  {@render children?.(view.decision)}
{/if}
