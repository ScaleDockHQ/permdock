import type { RouteDefinition, RouteSectionProps } from '@solidjs/router';

import { createAsync, revalidate } from '@solidjs/router';
import { PermDockProvider, usePermission } from 'permdock/solid';
import { For, Show, Suspense, onCleanup, onMount } from 'solid-js';

import type { NavItem } from '@permdock/e2e-saas-kit/nav';

import { navItems, orgs } from '@permdock/e2e-saas-kit/nav';

import type { OrgView } from '../lib/saas';

import { getOrgView, getProjects, getSnapshot } from '../lib/saas';

declare global {
  interface Window {
    saasPausePoll?: boolean;
  }
}

export const route = {
  preload: ({ params }) => {
    void getOrgView(params['org'] ?? '');
    void getSnapshot(params['org'] ?? '');
  },
} satisfies RouteDefinition;

function Item(props: {
  readonly item: NavItem;
  readonly org: NonNullable<OrgView>;
}) {
  const state = usePermission(() => props.item.permission);
  return (
    <Show
      when={state().allowed}
      fallback={
        <Show when={props.item.pro === true && props.org.plan !== 'pro'}>
          <li data-upsell={props.item.id}>
            {props.item.label}: upgrade to Pro
          </li>
        </Show>
      }
    >
      <li>
        <a href={`/${props.org.id}${props.item.path}`} data-nav={props.item.id}>
          {props.item.label}
        </a>
      </li>
    </Show>
  );
}

/** Other members learn about role or plan changes by polling; queries revalidate. */
function RefreshSignal(props: {
  readonly org: string;
  readonly issuedAt: number;
}) {
  onMount(() => {
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
          if (props.issuedAt > 0 && body.changedAt >= props.issuedAt) {
            await revalidate([
              getOrgView.key,
              getSnapshot.key,
              getProjects.key,
            ]);
          }
        })
        .catch(() => undefined);
    }, 500);
    onCleanup(() => {
      clearInterval(id);
    });
  });
  return null;
}

function OrgHeader() {
  return (
    <header>
      <nav aria-label="Organizations">
        <For each={orgs}>
          {(item) => (
            <a href={`/${item.id}`} data-switch={item.id}>
              {item.name}
            </a>
          )}
        </For>
      </nav>
      <form method="post" action="/api/logout">
        <button type="submit">Sign out</button>
      </form>
    </header>
  );
}

export default function OrgLayout(props: RouteSectionProps) {
  const org = createAsync(() => getOrgView(props.params['org'] ?? ''));
  const snapshot = createAsync(() => getSnapshot(props.params['org'] ?? ''));
  // The provider mounts once the snapshot has resolved inside the boundary, so
  // streaming SSR serialises it and hydration builds the store from it.
  return (
    <Suspense fallback={<nav aria-busy="true" data-testid="nav-skeleton" />}>
      <Show when={snapshot()}>
        {(current) => (
          <PermDockProvider snapshot={current}>
            <OrgHeader />
            <Show
              when={org()}
              fallback={<p role="alert">Unknown organization</p>}
            >
              {(view) => (
                <nav
                  aria-label="Main"
                  data-testid="nav"
                  data-plan={view().plan}
                >
                  <ul>
                    <For each={navItems}>
                      {(item) => <Item item={item} org={view()} />}
                    </For>
                  </ul>
                </nav>
              )}
            </Show>
            <RefreshSignal
              org={props.params['org'] ?? ''}
              issuedAt={current().issuedAt}
            />
            <main>{props.children}</main>
          </PermDockProvider>
        )}
      </Show>
    </Suspense>
  );
}
