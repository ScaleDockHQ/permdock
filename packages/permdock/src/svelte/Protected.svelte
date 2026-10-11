<script lang="ts">
  import { onDestroy } from 'svelte';

  import {
    getStore,
    getUi,
    scopedFor,
    slotContent,
    viewFor,
    type ProtectedProps,
  } from './runtime.ts';

  let {
    permission,
    data,
    tenant,
    children,
    pending,
    fallback,
    approval,
  }: ProtectedProps = $props();

  const store = getStore();
  const { defaults } = getUi();
  let tick = $state(0);
  onDestroy(
    store.subscribe(() => {
      tick += 1;
    }),
  );
  const scoped = $derived(scopedFor(store, tenant, tick));
  const view = $derived.by(() => {
    const generation = tick;
    return viewFor(store, permission, data, scoped, generation);
  });
  const own = $derived({ pending, fallback, approval });
</script>

{#if view.slot === 'pending'}
  {@render slotContent('pending', own, defaults)?.()}
{:else if view.slot === 'approval'}
  {@render slotContent('approval', own, defaults)?.(view.decision)}
{:else if view.slot === 'fallback'}
  {@render slotContent('fallback', own, defaults)?.(view.decision)}
{:else}
  {@render children?.(view.decision)}
{/if}
