<script setup lang="ts">
import { permissions } from '@permdock/e2e-saas-kit/nav';
import { usePermission } from 'permdock/vue';

const { allowed } = usePermission(permissions.project.list);
</script>

<template>
  <div>
    <h1>Overview</h1>
    <p v-if="allowed" data-testid="overview">Welcome back.</p>
    <Forbidden v-else />
  </div>
</template>
