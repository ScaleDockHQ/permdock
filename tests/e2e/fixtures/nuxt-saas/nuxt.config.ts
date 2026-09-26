export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  telemetry: false,
  // Workspace packages ship TypeScript sources; Nitro must bundle them.
  build: { transpile: ['@permdock/e2e-saas-kit'] },
  nitro: { externals: { inline: ['@permdock/e2e-saas-kit'] } },
});
