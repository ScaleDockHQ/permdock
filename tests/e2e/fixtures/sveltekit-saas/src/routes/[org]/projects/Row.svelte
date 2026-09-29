<script lang="ts">
  import type { SaasProject } from 'permdock/testing/saas';

  import { invalidateAll } from '$app/navigation';
  import { permissions } from '@permdock/e2e-saas-kit/nav';
  import { permission } from 'permdock/svelte';

  import { removeProject } from '$lib/projects.remote';

  let { project }: { project: SaasProject } = $props();
  const remove = permission(permissions.project.delete, () => project);
  let result = $state('');

  async function onDelete(): Promise<void> {
    const outcome = await removeProject(project.id);
    if (outcome.ok) {
      await invalidateAll();
    } else {
      result = `Denied: ${outcome.reason ?? 'denied'}`;
    }
  }
</script>

<li data-project={project.id}>
  {project.name}
  {#if $remove.allowed}
    <button type="button" onclick={onDelete}>Delete</button>
  {/if}
  <output>{result}</output>
</li>
