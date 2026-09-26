<script lang="ts">
  import { orgs } from '@permdock/e2e-saas-kit/nav';
</script>

<h1>Your organizations</h1>
<ul>
  {#each orgs as org (org.id)}
    <li><a href="/{org.id}" data-org-link={org.id}>{org.name}</a></li>
  {/each}
</ul>
