import { Building2, ChevronRight, Store } from "lucide-react";
import Link from "next/link";

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

import { organizations } from "../lib/store.ts";

const destinations = [
  ...organizations.map((organization) => ({
    id: organization.id,
    href: `/${organization.id}`,
    title: organization.name,
    description: "Staff workspace: quotes, members and settings",
    portal: false,
  })),
  {
    id: "portal",
    href: "/portal/acme",
    title: "Acme customer portal",
    description: "What a customer contact sees",
    portal: true,
  },
];

export function Explore() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore</CardTitle>
        <CardDescription>
          A page your role may not open answers with a forbidden page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <nav aria-label="Organizations">
          <ul className="flex flex-col gap-2">
            {destinations.map((destination) => (
              <li key={destination.id}>
                <Item
                  variant="outline"
                  render={
                    <Link
                      href={destination.href}
                      prefetch
                      data-org-link={destination.id}
                    />
                  }
                >
                  <ItemMedia variant="icon">
                    {destination.portal ? <Store /> : <Building2 />}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{destination.title}</ItemTitle>
                    <ItemDescription>{destination.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight className="text-muted-foreground size-4" />
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        </nav>
      </CardContent>
    </Card>
  );
}
