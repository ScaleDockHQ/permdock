import type { Snapshot } from "permdock";

import { emptySnapshot } from "permdock";
import { permdockPlugin } from "permdock/vue";

/**
 * Nuxt creates the app per request on the server, so this plugin (and the
 * PermDock store it installs) is per request too. The snapshot lives in
 * `useState`, which Nuxt serialises into the payload for hydration. Vue
 * watchers do not run during SSR, so the server loads the route's snapshot
 * before installing; `[org].vue` keeps it current on the client.
 */
export default defineNuxtPlugin(async (nuxtApp) => {
  const snapshot = useState<Snapshot | null>("permdock:snapshot", () => null);
  const org = useRouter().currentRoute.value.params.org;
  if (
    import.meta.server &&
    typeof org === "string" &&
    snapshot.value === null
  ) {
    snapshot.value = await useRequestFetch()<Snapshot>("/api/snapshot", {
      query: { org },
    }).catch(() => null);
  }
  nuxtApp.vueApp.use(permdockPlugin, {
    snapshot: () => snapshot.value ?? emptySnapshot(),
  });
});
