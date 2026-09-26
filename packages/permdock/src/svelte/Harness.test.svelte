<script lang="ts">
  import type { ProtectedProps } from './runtime.ts';
  import type { PermDockSvelteOptions } from './types.ts';

  import Protected from './Protected.svelte';
  import { setPermDock } from './stores.ts';

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
