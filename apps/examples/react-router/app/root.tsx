import type { ReactNode } from "react";

import { PermDockProvider } from "permdock/react";
import { snapshotHeaders } from "permdock/server";
import {
  data,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import type { Route } from "./+types/root";

import { getSnapshot } from "./permdock.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const snapshot = await getSnapshot(request);
  return data({ snapshot }, { headers: snapshotHeaders(snapshot) });
}

export function headers({ loaderHeaders }: Route.HeadersArgs): Headers {
  return loaderHeaders;
}

export function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { snapshot } = useLoaderData<typeof loader>();
  return (
    <PermDockProvider snapshot={snapshot} endpoint="/api/permdock">
      <Outlet />
    </PermDockProvider>
  );
}
