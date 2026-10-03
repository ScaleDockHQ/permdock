import { defineConfig } from 'oxlint';

import {
  core,
  example,
  ignorePatterns,
  react,
} from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react, example],
  ignorePatterns: [
    ...ignorePatterns,
    'src/lib/supabase/{generated.*,database.types.ts}',
  ],
});
