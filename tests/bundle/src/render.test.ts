import { PermDockProvider, Protected as ReactProtected } from "permdock/react";
import {
  PermDockProvider as SolidProvider,
  Protected as SolidProtected,
} from "permdock/solid";
import { permdockPlugin, Protected as VueProtected } from "permdock/vue";
import { createElement } from "react";
import { renderToString as renderReact } from "react-dom/server";
import { createComponent } from "solid-js";
import { renderToString as renderSolid } from "solid-js/web";
import { render as renderSvelte } from "svelte/server";
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString as renderVue } from "vue/server-renderer";

import Harness from "./fixtures/ui/Harness.svelte";
import { memberSnapshot, permissions } from "./fixtures/ui/policy.ts";

const { read, update } = permissions.post;

type Guarded = typeof read | typeof update;

function reactGuard(permission: Guarded) {
  return createElement(ReactProtected, {
    permission,
    fallback: createElement("i", null, "denied"),
    children: createElement("b", null, "granted"),
  });
}

function vueGuard(permission: Guarded) {
  return h(
    VueProtected,
    { permission },
    {
      default: () => h("b", "granted"),
      fallback: () => h("i", "denied"),
    },
  );
}

function solidGuard(permission: Guarded) {
  return createComponent(SolidProtected, {
    permission,
    fallback: "<i>denied</i>",
    children: "<b>granted</b>",
  });
}

function granted(html: string): void {
  expect(html).toContain("<b>granted</b>");
  expect(html).toContain("<i>denied</i>");
}

describe("server rendering from dist", () => {
  it("permdock/react renders through react-dom/server", async () => {
    const snapshot = await memberSnapshot();
    granted(
      renderReact(
        createElement(PermDockProvider, {
          snapshot,
          children: [reactGuard(read), reactGuard(update)],
        }),
      ),
    );
  });

  it("permdock/vue renders through vue/server-renderer", async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      render: () => h("div", [vueGuard(read), vueGuard(update)]),
    });
    app.use(permdockPlugin, { snapshot });
    granted(await renderVue(app));
  });

  it("permdock/svelte renders its published source through svelte/server", async () => {
    const snapshot = await memberSnapshot();
    const { body } = await renderSvelte(Harness, {
      props: { snapshot, granted: read, denied: update },
    });
    granted(body);
    expect(body).toContain("<s>function</s>");
  });

  it("permdock/solid renders through solid-js/web", async () => {
    const snapshot = await memberSnapshot();
    const html = renderSolid(() =>
      createComponent(SolidProvider, {
        snapshot,
        get children() {
          return [solidGuard(read), solidGuard(update)];
        },
      }),
    );
    expect(html).toContain("granted");
    expect(html).toContain("denied");
  });
});
