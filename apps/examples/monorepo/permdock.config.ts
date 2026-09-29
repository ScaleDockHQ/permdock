import { defineConfig } from 'permdock/cli';

export default defineConfig({
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  collect: {
    srcPath: ['./src', './packages/posts/src', './packages/billing/src'],
  },
});
