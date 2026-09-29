<script setup lang="ts">
import type { SaasProject } from 'permdock/testing/saas';

const route = useRoute();
const org = computed(() => String(route.params.org));
const requestFetch = useRequestFetch();
const { data } = await useAsyncData(
  () => `projects:${org.value}`,
  () =>
    requestFetch<{ forbidden: boolean; projects: SaasProject[] }>(
      '/api/projects',
      {
        query: { org: org.value },
      },
    ),
);
</script>

<template>
  <div>
    <h1>Projects</h1>
    <Forbidden v-if="data?.forbidden" label="Projects" />
    <ul v-else aria-label="Projects">
      <ProjectRow
        v-for="project in data?.projects ?? []"
        :key="project.id"
        :project="project"
      />
    </ul>
  </div>
</template>
