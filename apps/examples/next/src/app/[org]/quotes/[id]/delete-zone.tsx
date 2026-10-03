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
    <form action={deleteQuote.bind(null, org, quote.id)}>
      <button type="submit" data-action="delete">
        Delete quote
      </button>
    </form>
  );
}
