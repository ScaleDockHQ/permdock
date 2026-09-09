<script lang="ts">
  import type { Snapshot } from 'permdock';

  import { Protected, setPermDock } from 'permdock/svelte';

  import { ownPost, permissions } from './permissions.ts';

  let { snapshot }: { snapshot: Snapshot } = $props();
  const initial = snapshot;
  setPermDock({ snapshot: initial });
</script>

<Protected permission={permissions.post.update} data={ownPost}>
  <span>edit</span>
  {#snippet fallback()}<span>locked</span>{/snippet}
</Protected>
<Protected permission={permissions.post.publish} data={ownPost}>
  <span>publish</span>
  {#snippet fallback()}<span>locked</span>{/snippet}
</Protected>
