<script setup lang="ts">
import type { Snapshot } from 'permdock';

import { navItems, orgs } from '@permdock/e2e-saas-kit/nav';

const route = useRoute();
const org = computed(() => String(route.params.org));
const requestFetch = useRequestFetch();
const snapshot = useState<Snapshot | null>('permdock:snapshot');

const { data: fetched, error } = await useAsyncData(
  () => `snapshot:${org.value}`,
  () => requestFetch<Snapshot>('/api/snapshot', { query: { org: org.value } }),
);
if (error.value?.statusCode === 401) {
  await navigateTo('/login');
}
watch(
  fetched,
  (value) => {
    snapshot.value = value ?? null;
  },
  { immediate: true },
);
const { data: view } = await useAsyncData(
  () => `org:${org.value}`,
  () =>
    requestFetch<{ id: string; name: string; plan: string } | null>(
      '/api/org',
      {
        query: { org: org.value },
      },
    ),
);

// Other members learn about a role or plan change by polling; a realtime
// channel would carry the same signal in production.
onMounted(() => {
  const id = setInterval(() => {
    // SAFETY: saasPausePoll is an optional test hook the e2e spec sets on window
    if ((window as { saasPausePoll?: boolean }).saasPausePoll === true) {
      return;
    }
    $fetch<{ changedAt: number }>('/api/version', { query: { org: org.value } })
      .then((body) =>
        body.changedAt >= (snapshot.value?.issuedAt ?? Infinity)
          ? refreshNuxtData()
          : undefined,
      )
      .catch(() => undefined);
  }, 500);
  onBeforeUnmount(() => clearInterval(id));
});
</script>

<template>
  <div>
    <header>
      <nav aria-label="Organizations">
        <NuxtLink
          v-for="item in orgs"
          :key="item.id"
          :to="`/${item.id}`"
          :data-switch="item.id"
        >
          {{ item.name }}
        </NuxtLink>
      </nav>
      <form method="POST" action="/api/logout">
        <button type="submit">Sign out</button>
      </form>
    </header>
    <p v-if="view === null" role="alert">Unknown organization</p>
    <nav
      v-else-if="view"
      aria-label="Main"
      data-testid="nav"
      :data-plan="view.plan"
    >
      <ul>
        <NavEntry
          v-for="item in navItems"
          :key="item.id"
          :item="item"
          :org="view"
        />
      </ul>
    </nav>
    <main><NuxtPage /></main>
  </div>
</template>
