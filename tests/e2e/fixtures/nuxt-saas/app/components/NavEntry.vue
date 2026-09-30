<script setup lang="ts">
import { usePermission } from 'permdock/vue';

import type { NavItem } from '@permdock/e2e-saas-kit/nav';

const props = defineProps<{
  item: NavItem;
  org: { id: string; plan: string };
}>();
const { allowed } = usePermission(() => props.item.permission);
</script>

<template>
  <li v-if="allowed">
    <NuxtLink :to="`/${org.id}${item.path}`" :data-nav="item.id">{{
      item.label
    }}</NuxtLink>
  </li>
  <li
    v-else-if="item.pro === true && org.plan !== 'pro'"
    :data-upsell="item.id"
  >
    {{ item.label }}: upgrade to Pro
  </li>
</template>
