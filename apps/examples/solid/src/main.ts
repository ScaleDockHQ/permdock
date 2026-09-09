import { createPermDock } from 'permdock';
import { render } from 'solid-js/web';

import { App } from './app.ts';
import { memberUser, policy } from './policy.ts';

const dock = await createPermDock(policy, memberUser);
const snapshot = await Promise.resolve(dock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}

const root = document.querySelector('#root');
if (root !== null) {
  render(() => App({ snapshot }), root);
}
