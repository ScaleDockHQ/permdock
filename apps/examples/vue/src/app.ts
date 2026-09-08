import { Protected } from 'permdock/vue';
import { defineComponent, h } from 'vue';

import { ownPost, permissions } from './permissions.ts';

export const App = defineComponent({
  name: 'App',
  setup() {
    return () =>
      h(
        Protected,
        { permission: permissions.post.update, data: ownPost },
        { default: () => 'edit', fallback: () => 'locked' },
      );
  },
});
