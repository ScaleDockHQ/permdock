<script lang="ts">
  import { untrack } from 'svelte';

  let { digest }: { digest: () => string | null } = $props();

  const current = untrack(digest);
  if (current !== null) {
    throw Object.assign(new Error('refused'), { digest: current });
  }
</script>

content
