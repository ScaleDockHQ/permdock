<script setup lang="ts">
import { Protected } from "permdock/vue";

import { navItemFor } from "@permdock/e2e-saas-kit/nav";

const route = useRoute();
const item = computed(() => navItemFor(String(route.params.section)));
</script>

<template>
  <div>
    <h1 v-if="item === undefined">Not found</h1>
    <template v-else>
      <h1>{{ item.label }}</h1>
      <Protected :permission="item.permission">
        <p data-testid="section-content">{{ item.label }} content</p>
        <template #fallback><Forbidden :label="item.label" /></template>
      </Protected>
    </template>
  </div>
</template>
