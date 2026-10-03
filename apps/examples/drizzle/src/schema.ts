import { boolean, pgTable, text } from "drizzle-orm/pg-core";

export const posts = pgTable("post", {
  id: text("id").primaryKey(),
  authorId: text("authorId").notNull(),
  orgId: text("orgId").notNull(),
  title: text("title").notNull(),
  published: boolean("published").notNull(),
});
