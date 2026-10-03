import { Show } from "solid-js";

export function Forbidden(props: { readonly label?: string }) {
  return (
    <section role="alert" data-testid="forbidden">
      <h2>No access</h2>
      <Show
        when={props.label}
        fallback={<p>You are not a member of this organization.</p>}
      >
        {(label) => (
          <p>Your role in this organization does not include {label()}.</p>
        )}
      </Show>
    </section>
  );
}
