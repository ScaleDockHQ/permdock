export function Forbidden(props: { readonly label?: string }) {
  return (
    <section role="alert" data-testid="forbidden">
      <h2>No access</h2>
      <p>
        {props.label === undefined
          ? "You are not a member of this organization."
          : `Your role in this organization does not include ${props.label}.`}
      </p>
    </section>
  );
}
