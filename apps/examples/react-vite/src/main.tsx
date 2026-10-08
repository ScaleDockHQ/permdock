import { snapshotFor } from "permdock";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { memberUser, policy } from "./policy.ts";

const snapshot = snapshotFor(policy, memberUser);
const root = document.querySelector("#root");
if (root !== null) {
  createRoot(root).render(<App snapshot={snapshot} />);
}
