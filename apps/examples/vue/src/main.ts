import { snapshotFor } from "permdock";
import { permdockPlugin } from "permdock/vue";
import { createApp } from "vue";

import { App } from "./app.ts";
import { memberUser, policy } from "./policy.ts";

const snapshot = snapshotFor(policy, memberUser);

const root = document.querySelector("#root");
if (root !== null) {
  createApp(App).use(permdockPlugin, { snapshot }).mount(root);
}
