import { Trash2 } from "lucide-react";

import { SubmitButton } from "@/components/submit-button.tsx";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import { findQuote } from "../../../../lib/store.ts";
import { getPermDock } from "../../../../permdock/server.ts";
import { permissions } from "../../../../permissions.ts";
import { deleteQuote } from "../../../actions.ts";

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

/**
 * Checks at request time and throws: a denial or an approval request becomes
 * the `PermissionBoundary` fallback around it, and the rest of the page stays.
 */
export async function DeleteZone(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  const { org, id } = await props.params;
  const [quote, permdock] = await Promise.all([
    findQuote(org, id),
    getPermDock({ tenant: org }),
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
          <form action={deleteQuote.bind(null, org, quote.id)}>
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
