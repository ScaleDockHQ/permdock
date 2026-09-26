<script lang="ts">
  import type { Snippet } from 'svelte';

  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { navItems, orgs } from '@permdock/e2e-saas-kit/nav';
  import { setPermDock } from 'permdock/svelte';

  import type { LayoutData } from './$types';

  import NavItem from './NavItem.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  setPermDock({ snapshot: () => data.snapshot });

  // Other members learn about a role or plan change by polling; a realtime
  // channel would carry the same signal in production.
  $effect(() => {
    const org = page.params.org ?? '';
    const issuedAt = data.snapshot.issuedAt;
    const id = setInterval(() => {
      if (window.saasPausePoll === true) {
        return;
      }
      fetch(`/api/version?org=${encodeURIComponent(org)}`, { cache: 'no-store' })
        .then((response) => response.json() as Promise<{ changedAt: number }>)
        .then((body) => (body.changedAt >= issuedAt ? invalidateAll() : undefined))
        .catch(() => undefined);
    }, 500);
    return () => clearInterval(id);
  });
</script>

<header>
  <nav aria-label="Organizations">
    {#each orgs as item (item.id)}
      <a href="/{item.id}" data-switch={item.id}>{item.name}</a>
    {/each}
  </nav>
  <form method="POST" action="/api/logout" data-sveltekit-reload>
    <button type="submit">Sign out</button>
  </form>
</header>
{#if data.org === null}
  <p role="alert">Unknown organization</p>
{:else}
  <nav aria-label="Main" data-testid="nav" data-plan={data.org.plan}>
    <ul>
      {#each navItems as item (item.id)}
        <NavItem {item} org={data.org} />
      {/each}
    </ul>
  </nav>
{/if}
<main>{@render children()}</main>
