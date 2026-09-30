<script lang="ts">
  import type { ProtectedProps } from '../../src/svelte/runtime.ts';
  import type { PermDockSvelteOptions } from '../../src/svelte/types.ts';

  import Protected from '../../src/svelte/Protected.svelte';
  import { setPermDock } from '../../src/svelte/stores.ts';

  let {
    snapshot,
    permission,
    data,
  }: {
    snapshot: PermDockSvelteOptions['snapshot'];
    permission: ProtectedProps['permission'];
    data?: unknown;
  } = $props();

  // svelte-ignore state_referenced_locally
  setPermDock({ snapshot });
</script>

<Protected {permission} {data}>
  {#snippet children()}<b>granted</b>{/snippet}
  {#snippet fallback()}<i>denied</i>{/snippet}
  {#snippet pending()}<u>pending</u>{/snippet}
</Protected>
