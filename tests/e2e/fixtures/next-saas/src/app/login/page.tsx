import { users } from "../../nav.ts";
import { signIn } from "../actions.ts";

export default function LoginPage() {
  return (
    <main>
      <h1>Sign in</h1>
      {users.map((user) => (
        <form key={user} action={signIn}>
          <input type="hidden" name="user" value={user} />
          <input type="hidden" name="next" value="/acme" />
          <button type="submit">Sign in as {user}</button>
        </form>
      ))}
    </main>
  );
}
