import type { BlockSqlLayout } from "better-supabase/sql";

import { renderBlocks } from "better-supabase/sql";

/** The SQL files of better-supabase's permissions block. */
export function permissionsBlockSql(layout: BlockSqlLayout): readonly string[] {
  return renderBlocks(["permissions"], layout).map((file) => file.contents);
}
