import { revalidateTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import { orgTag } from "../../../../lib/access.ts";
import { organizations, people, resetStore } from "../../../../lib/store.ts";

/** Test-only: restores the seed between e2e scenarios. */
export function POST(): Response {
  if (process.env["NEXT_E2E"] !== "1") {
    return new Response(null, { status: 404 });
  }
  resetStore();
  for (const organization of organizations) {
    revalidateTag(orgTag(organization.id), { expire: 0 });
  }
  for (const person of people) {
    revalidateTag(snapshotTag(person.id), { expire: 0 });
  }
  return Response.json({ ok: true });
}
