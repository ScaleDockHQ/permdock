import { createPermDock } from 'permdock';
import { mount } from 'svelte';

import App from './app.svelte';
import { memberUser, policy } from './policy.ts';

const permdock = await createPermDock(policy, memberUser);
const snapshot = await Promise.resolve(permdock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}

const root = document.querySelector('#root');
if (root !== null) {
  mount(App, { target: root, props: { snapshot } });
}
