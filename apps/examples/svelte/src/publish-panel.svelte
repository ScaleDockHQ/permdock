<script lang="ts">
  import { getPermDock } from 'permdock/svelte';

  import { ownPost, permissions } from './permissions.ts';

  getPermDock().assert(permissions.post.publish, ownPost);
</script>

<span>publish panel</span>
