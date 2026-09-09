import { Protected } from 'permdock/vue';
import { defineComponent, h } from 'vue';

import { ownPost, permissions } from './permissions.ts';

export const App = defineComponent({
  name: 'App',
  setup() {
    return () => [
      h(
        Protected,
        { permission: permissions.post.update, data: ownPost },
        {
          default: () => h('span', 'edit'),
          fallback: () => h('span', 'locked'),
        },
      ),
      h(
        Protected,
        { permission: permissions.post.publish, data: ownPost },
        {
          default: () => h('span', 'publish'),
          fallback: () => h('span', 'locked'),
        },
      ),
    ];
  },
});
