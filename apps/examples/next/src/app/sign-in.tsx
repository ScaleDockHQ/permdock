import { initials } from "@/components/brand.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item.tsx";

import { people } from "../lib/store.ts";

export function SignIn() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a demo account</CardTitle>
        <CardDescription>
          Each person has a different role, so each sees a different app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Sign in" className="flex flex-col gap-2">
          {people.map((person) => (
            <Item key={person.id} variant="outline" render={<li />}>
              <ItemMedia>
                <Avatar>
                  <AvatarFallback>{initials(person.name)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{person.name}</ItemTitle>
                <ItemDescription>{person.title}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <form method="post" action="/api/session">
                  <input type="hidden" name="user" value={person.id} />
                  <Button
                    type="submit"
                    size="sm"
                    aria-label={`Sign in as ${person.name}`}
                  >
                    Sign in
                  </Button>
                </form>
              </ItemActions>
            </Item>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
