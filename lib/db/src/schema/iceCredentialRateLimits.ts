import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const iceCredentialRateLimitsTable = pgTable(
  "ice_credential_rate_limits",
  {
    clientKey: text("client_key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    requestCount: integer("request_count").notNull(),
  },
  (table) => [
    index("ice_credential_rate_limits_window_idx").on(table.windowStartedAt),
  ],
);