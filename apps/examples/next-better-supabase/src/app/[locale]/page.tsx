import { demoPeople } from "../../features/auth/people.ts";
import { signInAction } from "../../features/auth/sign-in-action.ts";

const people = Object.entries(demoPeople);

/** Signs in through Supabase Auth, which runs the access-token hook. */
export default function Home() {
  return (
    <main>
      <h1>Sign in as</h1>
      <ul>
        {people.map(([id, person]) => (
          <li key={id}>
            <form action={signInAction}>
              <input name="user" type="hidden" value={id} />
              <input name="next" type="hidden" value={person.next} />
              <button type="submit" data-sign-in={id}>
                {`Sign in as ${person.name}`}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
