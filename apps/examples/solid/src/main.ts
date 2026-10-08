import { snapshotFor } from "permdock";
import { render } from "solid-js/web";

import { App } from "./app.ts";
import { memberUser, policy } from "./policy.ts";

const snapshot = snapshotFor(policy, memberUser);

const root = document.querySelector("#root");
if (root !== null) {
  render(() => App({ snapshot }), root);
}
