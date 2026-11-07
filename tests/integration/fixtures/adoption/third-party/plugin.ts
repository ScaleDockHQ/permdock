import { definePlugin } from "permdock/cli";

/** A generator plugin outside the permdock package. It uses only definePlugin. */
export const fixturePlugin = definePlugin({
  name: "fixture-plugin",
  version: "1.0.0",
  plan: () => [{ id: "note", out: "out/third-party.txt" }],
  emit: (_task, model) => [
    {
      path: "out/third-party.txt",
      contents: `${model.permissions.map((leaf) => leaf.key).join("\n")}\n`,
    },
  ],
});
