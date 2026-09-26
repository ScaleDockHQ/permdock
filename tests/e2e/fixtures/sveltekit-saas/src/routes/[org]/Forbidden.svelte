<script lang="ts">
  let { label }: { label?: string } = $props();
</script>

<section role="alert" data-testid="forbidden">
  <h2>No access</h2>
  <p>
    {label === undefined
      ? 'You are not a member of this organization.'
      : `Your role in this organization does not include ${label}.`}
  </p>
</section>
