import type { JSX, ParentProps } from "solid-js";

import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

function Root(props: ParentProps): JSX.Element {
  return <Suspense>{props.children}</Suspense>;
}

export default function App(): JSX.Element {
  return (
    <Router root={Root}>
      <FileRoutes />
    </Router>
  );
}
