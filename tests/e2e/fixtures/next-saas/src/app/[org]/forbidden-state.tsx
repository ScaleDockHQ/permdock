export function ForbiddenState(props: { readonly label: string }) {
  return (
    <section role="alert" data-testid="forbidden">
      <h2>No access</h2>
      <p>Your role in this organization does not include {props.label}.</p>
    </section>
  );
}
