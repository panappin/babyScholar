import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Infrastructure verification only. Paper schema belongs to a later phase.
export const storageProbes = sqliteTable("storage_probes", {
  id: text("id").primaryKey().notNull(),
  value: text("value").notNull(),
});
