import { createPermDock } from 'permdock';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';
import { memberUser, policy } from './policy.ts';

const permdock = await createPermDock(policy, memberUser);
const snapshot = await Promise.resolve(permdock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}
const root = document.querySelector('#root');
if (root !== null) {
  createRoot(root).render(<App snapshot={snapshot} />);
}
