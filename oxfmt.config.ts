import { oxfmt } from "@permdock/ox-config/oxfmt";

export default oxfmt({
  ignorePatterns: [
    "**/.agents/**",
    "**/.cursor/**",
    "**/.claude/**",
    "**/permissions.catalog.json",
    "packages/ui/src/**",
    "apps/marketing/components/blocks/**",
    "apps/marketing/components/examples/**",
    "tests/integration/src/support/prisma/**",
    "apps/examples/prisma/src/generated/**",
    "apps/examples/next-better-supabase/src/lib/supabase/{generated.*,database.types.ts}",
  ],
  tailwindStylesheets: [
    { files: ["apps/docs/**"], stylesheet: "apps/docs/app/global.css" },
    {
      files: ["apps/marketing/**"],
      stylesheet: "apps/marketing/app/globals.css",
    },
  ],
});
