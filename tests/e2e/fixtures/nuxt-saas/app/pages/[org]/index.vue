<script setup lang="ts">
import { usePermission } from 'permdock/vue';

import { permissions } from '@permdock/e2e-saas-kit/nav';

const { allowed } = usePermission(permissions.project.list);
</script>

<template>
  <div>
    <h1>Overview</h1>
    <p v-if="allowed" data-testid="overview">Welcome back.</p>
    <Forbidden v-else />
  </div>
</template>
