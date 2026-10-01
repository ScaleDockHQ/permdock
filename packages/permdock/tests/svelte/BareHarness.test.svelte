<script lang="ts">
  import type { ProtectedProps } from '../../src/svelte/runtime.ts';
  import type { PermDockSvelteOptions } from '../../src/svelte/types.ts';

  import { Protected } from '../../src/svelte/source.ts';
  import { setPermDock } from '../../src/svelte/stores.ts';

  let {
    options,
    permission,
    data,
    tenant,
  }: {
    options: PermDockSvelteOptions;
    permission: ProtectedProps['permission'];
    data?: unknown;
    tenant?: string;
  } = $props();

  // svelte-ignore state_referenced_locally
  setPermDock(options);
</script>

<Protected {permission} {data} {tenant} />
