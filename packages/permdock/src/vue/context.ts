import type { InjectionKey } from 'vue';

import type { ClientStore } from '../react/store.ts';

export const permDockKey: InjectionKey<ClientStore> = Symbol('permdock');
