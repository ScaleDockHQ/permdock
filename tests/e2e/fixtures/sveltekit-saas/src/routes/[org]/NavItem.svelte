<script lang="ts">
  import type { NavItem } from '@permdock/e2e-saas-kit/nav';

  import { permission } from 'permdock/svelte';

  let { item, org }: { item: NavItem; org: { id: string; plan: string } } = $props();
  const state = permission(item.permission);
</script>

{#if $state.allowed}
  <li><a href="/{org.id}{item.path}" data-nav={item.id}>{item.label}</a></li>
{:else if item.pro === true && org.plan !== 'pro'}
  <li data-upsell={item.id}>{item.label}: upgrade to Pro</li>
{/if}
