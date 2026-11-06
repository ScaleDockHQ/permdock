import { snapshotForSlug } from "../../../../../features/organization/organization-queries.ts";
import { PermDockProvider } from "../../../../../permdock/server.ts";

/**
 * The customer portal: same snapshot loader, the contact's grants are
 * customer-scoped.
 */
export default function PortalLayout(
  props: LayoutProps<"/[locale]/portal/[orgSlug]">,
) {
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <PermDockProvider snapshot={snapshot}>
      <main>{props.children}</main>
    </PermDockProvider>
  );
}
