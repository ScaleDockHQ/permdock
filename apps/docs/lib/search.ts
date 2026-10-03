import { createFromSource } from 'fumadocs-core/search/server';

import { source } from './source';

export const searchServer: ReturnType<typeof createFromSource> =
  createFromSource(source);
