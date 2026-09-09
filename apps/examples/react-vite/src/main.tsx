import { createPermDock } from 'permdock';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';
import { memberUser, policy } from './policy.ts';

const dock = await createPermDock(policy, memberUser);
const snapshot = await Promise.resolve(dock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}
const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(<App snapshot={snapshot} />);
}
