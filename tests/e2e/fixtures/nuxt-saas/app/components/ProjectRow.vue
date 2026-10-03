<script setup lang="ts">
import type { SaasProject } from "permdock/testing/saas";

import { usePermission } from "permdock/vue";

import { permissions } from "@permdock/e2e-saas-kit/nav";

const props = defineProps<{ project: SaasProject }>();
const { allowed: canDelete } = usePermission(
  permissions.project.delete,
  () => props.project,
);
const result = ref("");

async function onDelete(): Promise<void> {
  const outcome = await $fetch<{ ok: boolean; reason?: string }>(
    `/api/projects/${props.project.id}/delete`,
    { method: "POST", ignoreResponseError: true },
  );
  if (outcome.ok) {
    await refreshNuxtData();
  } else {
    result.value = `Denied: ${outcome.reason ?? "denied"}`;
  }
}
</script>

<template>
  <li :data-project="project.id">
    {{ project.name }}
    <button v-if="canDelete" type="button" @click="onDelete">Delete</button>
    <output>{{ result }}</output>
  </li>
</template>
