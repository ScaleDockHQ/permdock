<script lang="ts">
  import { page } from '$app/state';
  import { navItemFor } from '@permdock/e2e-saas-kit/nav';
  import { Protected } from 'permdock/svelte';

  import Forbidden from '../Forbidden.svelte';

  const item = $derived(navItemFor(page.params.section));
</script>

{#if item === undefined}
  <h1>Not found</h1>
{:else}
  <h1>{item.label}</h1>
  <Protected permission={item.permission}>
    <p data-testid="section-content">{item.label} content</p>
    {#snippet fallback()}<Forbidden label={item.label} />{/snippet}
  </Protected>
{/if}
