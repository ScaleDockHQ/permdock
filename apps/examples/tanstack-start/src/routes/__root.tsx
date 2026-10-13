import type { ReactNode } from "react";

import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";

function RootComponent(): ReactNode {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { title: "PermDock" }] }),
  component: RootComponent,
});
