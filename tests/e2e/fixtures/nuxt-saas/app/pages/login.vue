<script setup lang="ts">
import { loginUsers } from "@permdock/e2e-saas-kit/nav";
</script>

<template>
  <main>
    <h1>Sign in</h1>
    <form
      v-for="user in loginUsers"
      :key="user"
      method="POST"
      action="/api/login"
    >
      <input type="hidden" name="user" :value="user" />
      <button type="submit">Sign in as {{ user }}</button>
    </form>
  </main>
</template>
