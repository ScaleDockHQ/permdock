import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { findQuote } from "../../../../lib/store.ts";
import { getPermDock } from "../../../../permdock/server.ts";
import { permissions } from "../../../../permissions.ts";
import { deleteQuote } from "../../../actions.ts";

/**
 * Checks at request time and throws: a denial or an approval request becomes
 * the `PermissionBoundary` fallback around it, and the rest of the page stays.
 */
export async function DeleteZone(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  const { org, id } = await props.params;
  const quote = await findQuote(org, id);
  if (quote === null) {
    return null;
  }
  const permdock = await getPermDock({ tenant: org });
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
            <Button type="submit" variant="destructive" data-action="delete">
              <Trash2 data-icon="inline-start" />
              Delete quote
            </Button>
          </form>
        </CardAction>
      </CardHeader>
    </Card>
  );
}
