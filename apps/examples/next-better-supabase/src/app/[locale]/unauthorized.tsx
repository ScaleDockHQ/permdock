/** `unauthorized()` from a route that needs a signed-in caller. */
export default function Unauthorized() {
  return (
    <main data-testid="unauthorized">
      <h1>Sign in to continue</h1>
      <p>This page needs a signed-in account.</p>
    </main>
  );
}
