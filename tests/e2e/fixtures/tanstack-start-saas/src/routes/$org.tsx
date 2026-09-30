import type { Snapshot } from 'permdock';

import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router';
import { PermDockProvider, usePermDock, usePermission } from 'permdock/react';
import { Suspense, useEffect } from 'react';

import type { NavItem } from '@permdock/e2e-saas-kit/nav';

import { navItems, orgs } from '@permdock/e2e-saas-kit/nav';

import type { OrgView } from '../lib/saas.functions';

import { getOrgView, getSnapshot } from '../lib/saas.functions';

declare global {
  interface Window {
    saasPausePoll?: boolean;
  }
}

export const Route = createFileRoute('/$org')({
  loader: async ({ params }) => {
    const view = await getOrgView({ data: { org: params.org } });
    if (!view.signedIn) {
      // TanStack Router's redirect contract: loaders throw the redirect object.
      // oxlint-disable-next-line typescript/only-throw-error
      throw redirect({ to: '/login' });
    }
    // Not awaited: the snapshot streams in and `PermDockProvider` follows it.
    const snapshot: Promise<Snapshot> = getSnapshot({
      data: { org: params.org },
    });
    return { org: view.org, snapshot };
  },
  component: OrgLayout,
});

function Item(props: {
  readonly item: NavItem;
  readonly org: NonNullable<OrgView>;
}) {
  const { allowed } = usePermission(props.item.permission);
  if (allowed) {
    return (
      <li>
        <a href={`/${props.org.id}${props.item.path}`} data-nav={props.item.id}>
          {props.item.label}
        </a>
      </li>
    );
  }
  if (props.item.pro === true && props.org.plan !== 'pro') {
    return (
      <li data-upsell={props.item.id}>{props.item.label}: upgrade to Pro</li>
    );
  }
  return null;
}

/** Other members learn about role or plan changes by polling; loaders revalidate. */
function RefreshSignal(props: { readonly org: string }) {
  const router = useRouter();
  const snapshot = usePermDock().snapshot();
  const issuedAt = snapshot instanceof Promise ? 0 : snapshot.issuedAt;
  useEffect(() => {
    const id = setInterval(() => {
      if (window.saasPausePoll === true) {
        return;
      }
      // SAFETY: the fixture's /api/version route answers { changedAt: number }
      fetch(`/api/version?org=${encodeURIComponent(props.org)}`, {
        cache: 'no-store',
      })
        .then((response) => response.json() as Promise<{ changedAt: number }>)
        .then(async (body) => {
          if (issuedAt > 0 && body.changedAt >= issuedAt) {
            await router.invalidate();
          }
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      clearInterval(id);
    };
  }, [props.org, router, issuedAt]);
  return null;
}

function OrgLayout() {
  const { org, snapshot } = Route.useLoaderData();
  const { org: id } = Route.useParams();
  return (
    <PermDockProvider snapshotPromise={snapshot}>
      <header>
        <nav aria-label="Organizations">
          {orgs.map((item) => (
            <Link
              key={item.id}
              to="/$org"
              params={{ org: item.id }}
              data-switch={item.id}
            >
              {item.name}
            </Link>
          ))}
        </nav>
        <form method="post" action="/api/logout">
          <button type="submit">Sign out</button>
        </form>
      </header>
      {org === null ? (
        <p role="alert">Unknown organization</p>
      ) : (
        <Suspense
          fallback={<nav aria-busy="true" data-testid="nav-skeleton" />}
        >
          <nav aria-label="Main" data-testid="nav" data-plan={org.plan}>
            <ul>
              {navItems.map((item) => (
                <Item key={item.id} item={item} org={org} />
              ))}
            </ul>
          </nav>
          <RefreshSignal org={id} />
        </Suspense>
      )}
      <main>
        <Outlet />
      </main>
    </PermDockProvider>
  );
}
