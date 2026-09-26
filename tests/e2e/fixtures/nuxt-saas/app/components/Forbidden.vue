<script setup lang="ts">
defineProps<{ label?: string }>();
</script>

<template>
  <section role="alert" data-testid="forbidden">
    <h2>No access</h2>
    <p v-if="label === undefined">You are not a member of this organization.</p>
    <p v-else>Your role in this organization does not include {{ label }}.</p>
  </section>
</template>
