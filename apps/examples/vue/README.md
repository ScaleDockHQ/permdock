# `@permdock/example-vue`

Minimal Vue wiring for `permdock/vue`: a Snapshot v3 built in the app, `permdockPlugin`, and `<Protected>` guards. Vite serves the page.

```bash
pnpm --filter @permdock/example-vue dev
```

Opens `http://127.0.0.1:3481/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish.

```ts
import { permdockPlugin, Protected } from "permdock/vue";
```
