import { For } from "solid-js";

import { loginUsers } from "@permdock/e2e-saas-kit/nav";

export default function Login() {
  return (
    <main>
      <h1>Sign in</h1>
      <For each={loginUsers}>
        {(user) => (
          <form method="post" action="/api/login">
            <input type="hidden" name="user" value={user} />
            <button type="submit">Sign in as {user}</button>
          </form>
        )}
      </For>
    </main>
  );
}
