import { definePermissions, definePolicy, resource } from "permdock";
import { defineConfig } from "permdock/cli";

const quotes = definePermissions({
  quote: resource({ actions: ["read", "update"] }),
});

const policy = definePolicy(quotes, {
  scopes: { organization: { key: "orgId" } },
  subject: (user: { readonly id: string } | null) => user,
});

export const config = defineConfig({
  policy,
  rls: {
    tables: { quote: "quotes" },
    scopeTypes: { organization: "uuid" },
    realtime: {
      topics: { "org:{organization}:quotes": { read: quotes.quote.read } },
    },
  },
});

export const misspelt = defineConfig({
  policy,
  rls: {
    // @ts-expect-error the scope is organization, not organisation
    scopeTypes: { organisation: "uuid" },
  },
});

export const placeholder = defineConfig({
  policy,
  rls: {
    realtime: {
      // @ts-expect-error a topic placeholder names a declared scope
      topics: { "org:{organisation}:quotes": { read: quotes.quote.read } },
    },
  },
});
