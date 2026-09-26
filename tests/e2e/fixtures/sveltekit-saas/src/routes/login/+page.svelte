<script lang="ts">
  import { loginUsers } from '@permdock/e2e-saas-kit/nav';
</script>

<h1>Sign in</h1>
{#each loginUsers as user (user)}
  <form method="POST" action="/api/login" data-sveltekit-reload>
    <input type="hidden" name="user" value={user} />
    <button type="submit">Sign in as {user}</button>
  </form>
{/each}
