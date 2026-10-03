<script setup lang="ts">
import { orgs } from "@permdock/e2e-saas-kit/nav";
</script>

<template>
  <main>
    <h1>Your organizations</h1>
    <ul>
      <li v-for="org in orgs" :key="org.id">
        <NuxtLink :to="`/${org.id}`" :data-org-link="org.id">{{
          org.name
        }}</NuxtLink>
      </li>
    </ul>
  </main>
</template>
