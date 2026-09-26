import { StartClient, mount } from '@solidjs/start/client';

const root = document.querySelector('#app');
if (root !== null) {
  mount(() => <StartClient />, root);
}
