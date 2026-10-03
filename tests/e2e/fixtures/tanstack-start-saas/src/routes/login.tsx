import { createFileRoute } from "@tanstack/react-router";

import { loginUsers } from "@permdock/e2e-saas-kit/nav";

export const Route = createFileRoute("/login")({
  component: () => (
    <main>
      <h1>Sign in</h1>
      {loginUsers.map((user) => (
        <form key={user} method="post" action="/api/login">
          <input type="hidden" name="user" value={user} />
          <button type="submit">Sign in as {user}</button>
        </form>
      ))}
    </main>
  ),
});
