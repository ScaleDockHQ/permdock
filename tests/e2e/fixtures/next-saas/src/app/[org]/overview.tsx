"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Protected } from "permdock/react";

import { navItems } from "../../nav.ts";
import { permissions } from "../../permissions.ts";
import { ForbiddenState } from "./forbidden-state.tsx";

export function DeniedBanner() {
  const denied = useSearchParams().get("denied");
  const item =
    denied === null ? undefined : navItems.find((entry) => entry.id === denied);
  if (item === undefined) {
    return null;
  }
  return <p role="status">Redirected: you cannot open {item.label}.</p>;
}

/** Ungated links, so a test can reach a page the nav hides. */
export function QuickLinks() {
  const { org } = useParams<{ org: string }>();
  return (
    <Protected
      permission={permissions.project.list}
      fallback={<ForbiddenState />}
    >
      <Links org={org} />
    </Protected>
  );
}

function Links(props: { readonly org: string }) {
  const { org } = props;
  return (
    <ul aria-label="Quick links">
      {navItems
        .filter((item) => item.path !== "")
        .map((item) => (
          <li key={item.id}>
            <Link
              href={`/${org}${item.path}`}
              prefetch={false}
              data-quick={item.id}
            >
              {item.label}
            </Link>
          </li>
        ))}
    </ul>
  );
}
