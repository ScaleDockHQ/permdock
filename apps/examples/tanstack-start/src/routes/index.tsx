import type { ReactNode } from "react";

import { createFileRoute } from "@tanstack/react-router";

function Home(): ReactNode {
  return <h1>PermDock on TanStack Start</h1>;
}

export const Route = createFileRoute("/")({ component: Home });
