import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { demoPeople } from "../../features/auth/people.ts";
import { signInAction } from "../../features/auth/sign-in-action.ts";

const people = Object.entries(demoPeople);

/** Signs in through Supabase Auth, which runs the access-token hook. */
export default function Home() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in as</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {people.map(([id, person]) => (
              <li key={id}>
                <form action={signInAction}>
                  <input name="user" type="hidden" value={id} />
                  <input name="next" type="hidden" value={person.next} />
                  <Button type="submit" size="sm" data-sign-in={id}>
                    {`Sign in as ${person.name}`}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
