<script lang="ts">
  import { permissions } from '@permdock/e2e-saas-kit/nav';
  import { Protected } from 'permdock/svelte';

  import Forbidden from './Forbidden.svelte';
</script>

<h1>Overview</h1>
<Protected permission={permissions.project.list}>
  <p data-testid="overview">Welcome back.</p>
  {#snippet fallback()}<Forbidden />{/snippet}
</Protected>
