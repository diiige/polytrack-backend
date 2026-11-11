import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const multiplayerRoomsTable = pgTable(
  "multiplayer_rooms",
  {
    inviteCode: text("invite_code").primaryKey(),
    hostInstanceId: text("host_instance_id").notNull(),
    hostConnectionId: text("host_connection_id").notNull(),
    version: text("version").notNull(),
    playerCount: integer("player_count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("multiplayer_rooms_expiry_idx").on(table.expiresAt)],
);

export const multiplayerSessionsTable = pgTable(
  "multiplayer_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    inviteCode: text("invite_code")
      .notNull()
      .references(() => multiplayerRoomsTable.inviteCode, { onDelete: "cascade" }),
    hostInstanceId: text("host_instance_id").notNull(),
    hostConnectionId: text("host_connection_id").notNull(),
    joinInstanceId: text("join_instance_id").notNull(),
    joinConnectionId: text("join_connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("multiplayer_sessions_invite_idx").on(table.inviteCode),
    index("multiplayer_sessions_host_idx").on(
      table.hostInstanceId,
      table.hostConnectionId,
    ),
  ],
);

export const multiplayerSignalsTable = pgTable(
  "multiplayer_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetInstanceId: text("target_instance_id").notNull(),
    targetConnectionId: text("target_connection_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("multiplayer_signals_delivery_idx").on(
      table.targetInstanceId,
      table.createdAt,
    ),
  ],
);

export const insertMultiplayerRoomSchema = createInsertSchema(
  multiplayerRoomsTable,
).omit({ createdAt: true });
export const insertMultiplayerSessionSchema = createInsertSchema(
  multiplayerSessionsTable,
).omit({ createdAt: true });
export const insertMultiplayerSignalSchema = createInsertSchema(
  multiplayerSignalsTable,
).omit({ id: true, createdAt: true });

export type InsertMultiplayerRoom = z.infer<typeof insertMultiplayerRoomSchema>;
export type MultiplayerRoom = typeof multiplayerRoomsTable.$inferSelect;
export type InsertMultiplayerSession = z.infer<
  typeof insertMultiplayerSessionSchema
>;
export type MultiplayerSession = typeof multiplayerSessionsTable.$inferSelect;
export type InsertMultiplayerSignal = z.infer<
  typeof insertMultiplayerSignalSchema
>;
export type MultiplayerSignal = typeof multiplayerSignalsTable.$inferSelect;