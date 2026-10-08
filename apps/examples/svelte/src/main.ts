import { snapshotFor } from "permdock";
import { mount } from "svelte";

import App from "./app.svelte";
import { memberUser, policy } from "./policy.ts";

const snapshot = snapshotFor(policy, memberUser);

const root = document.querySelector("#root");
if (root !== null) {
  mount(App, { target: root, props: { snapshot } });
}
