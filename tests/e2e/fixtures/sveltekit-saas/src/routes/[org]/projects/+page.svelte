<script lang="ts">
  import Forbidden from '../Forbidden.svelte';
  import Row from './Row.svelte';

  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h1>Projects</h1>
{#if data.forbidden}
  <Forbidden label="Projects" />
{:else}
  <ul aria-label="Projects">
    {#each data.projects as project (project.id)}
      <Row {project} />
    {/each}
  </ul>
{/if}
