import { registerHooks } from 'node:module';

import { load } from './client-reference-loader.ts';

registerHooks({ load });
