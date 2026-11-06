import { Trash2 } from "lucide-react";
import { navigation } from "next/cache";

import { SubmitButton } from "@/components/submit-button.tsx";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import { getPermDock } from "../../../permdock/server.ts";
import { permissions } from "../../../permissions.ts";
import { deleteQuote } from "../quote-actions.ts";
import { getQuote } from "../quote-queries.ts";

/**
 * Checks at request time and throws: a denial or an approval request becomes
 * the `PermissionBoundary` fallback around it, and the rest of the page stays.
 * `navigation()` keeps the read and the check out of every prefetch, so only a
 * real navigation pays for them.
 */
export async function DeleteZone(props: {
  readonly organization: string;
  readonly id: string;
}) {
  await navigation();
  const [{ value: quote }, permdock] = await Promise.all([
    getQuote(props.organization, props.id),
    getPermDock({ tenant: props.organization }),
  ]);
  if (quote === null) {
    return null;
  }
  permdock.assert(permissions.quote.delete, quote);
  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle>Delete this quote</CardTitle>
        <CardDescription>
          The quote is removed for everyone in the organization.
        </CardDescription>
        <CardAction>
          <form action={deleteQuote.bind(null, props.organization, quote.id)}>
            <SubmitButton
              variant="destructive"
              data-action="delete"
              icon={<Trash2 data-icon="inline-start" />}
            >
              Delete quote
            </SubmitButton>
          </form>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

/** The delete zone's place while its request-time read and check run. */
export function DeleteZoneSkeleton() {
  return (
    <Card aria-busy="true" data-testid="delete-skeleton">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
      </CardHeader>
    </Card>
  );
}
