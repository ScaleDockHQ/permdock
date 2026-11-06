/** `forbidden()` from a route that needs a permission the caller lacks. */
export default function Forbidden() {
  return (
    <main data-testid="forbidden">
      <h1>You do not have access to this page</h1>
      <p>Ask an organization owner for the role that grants it.</p>
    </main>
  );
}
