<script lang="ts">
  import type { ApprovalRequiredDecision } from '../../src/core/decision.ts';
  import type { SveltePermDockOptions } from '../../src/svelte/types.ts';

  import Protected from '../../src/svelte/Protected.svelte';
  import { getDescribe, permission, setPermDock } from '../../src/svelte/stores.ts';
  import { otherPost, ownPost, permissions } from '../fixtures/quick-start.ts';

  let { snapshot }: { snapshot: SveltePermDockOptions['snapshot'] } = $props();

  // svelte-ignore state_referenced_locally
  setPermDock({
    snapshot,
    defaults: { fallback: no },
    messages: { reasons: { 'no-grant': 'Geen toegang' } },
  });
  const describe = getDescribe();
  const publish = permission(permissions.post.publish, () => ownPost);
</script>

{#snippet no()}no{/snippet}
{#snippet ask(decision: ApprovalRequiredDecision)}ask:{decision.reason}{/snippet}

<Protected permission={permissions.post.delete} data={ownPost} approval={ask}>
  {#snippet children()}delete{/snippet}
</Protected>|<Protected permission={permissions.post.delete} data={ownPost}>
  {#snippet children()}delete{/snippet}
  {#snippet fallback()}own{/snippet}
</Protected>|<Protected permission={permissions.post.update} data={otherPost}>
  {#snippet children()}edit{/snippet}
</Protected>|{describe($publish.decision).detail}
