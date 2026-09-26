import { defineConfig } from '@permdock/cli';

export default defineConfig({
  permissions: './packages/permissions/src/index.ts',
  collect: {
    srcPath: ['./apps/*/src', './packages/*/src'],
    out: './permissions.catalog.json',
  },
});
