import { createPermDock, type Policy } from 'permdock';
import { permdockPlugin } from 'permdock/vue';
import { createApp } from 'vue';

import { App } from './app.ts';
import { memberUser, policy } from './policy.ts';

const dock = await createPermDock(policy as Policy, memberUser);
const snapshot = await Promise.resolve(dock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}

const root = document.querySelector('#root');
if (root !== null) {
  createApp(App).use(permdockPlugin, { snapshot }).mount(root);
}
