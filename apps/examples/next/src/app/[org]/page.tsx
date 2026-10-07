import { Clock, KeyRound, Lock } from "lucide-react";

import { PageHeader } from "@/components/page-header.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item.tsx";

import { AccessSummary } from "./access-summary.tsx";

export const instant = true;

const layers = [
  {
    icon: KeyRound,
    title: "Private-cached snapshot",
    description:
      "Your permissions for this organization, cached per session with use cache: private.",
  },
  {
    icon: Clock,
    title: "Prefetched App Shell",
    description:
      "Gated links and buttons render from the snapshot a prefetch already carries.",
  },
  {
    icon: Lock,
    title: "Request-time checks for writes",
    description:
      "Server Actions call requireAccess again; the snapshot only decides what the UI shows.",
  },
];

export default function Overview() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="The navigation is gated by your role in this organization. Switching organizations or pages never waits for an access check."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your access here</CardTitle>
            <CardDescription>
              Read on the client from the same snapshot as the navigation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccessSummary />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Why navigation is instant</CardTitle>
            <CardDescription>
              What the snapshot decides, and what the server checks again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1">
              {layers.map((layer) => (
                <Item key={layer.title} size="sm" render={<li />}>
                  <ItemMedia variant="icon">
                    <layer.icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{layer.title}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {layer.description}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
