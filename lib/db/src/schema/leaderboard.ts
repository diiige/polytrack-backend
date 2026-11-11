import { boolean, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type ReplayBoostSettings = {
  accelerationMultiplier: number;
  brakingMultiplier: number;
  topSpeedMultiplier: number;
};

export type ReplayBoostTimelineSegment = ReplayBoostSettings & {
  startFrame: number;
  endFrame: number;
};

export type ReplayBoostTimeline = {
  version: 1;
  segments: ReplayBoostTimelineSegment[];
};

export const leaderboardRecordsTable = pgTable(
  "leaderboard_records",
  {
    id: serial("id").primaryKey(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
    nickname: text("nickname").notNull(),
    countryCode: text("country_code"),
    carStyle: text("car_style").notNull(),
    frames: integer("frames").notNull(),
    recording: text("recording").notNull(),
    replayBoostSettings: jsonb("replay_boost_settings").$type<ReplayBoostSettings>(),
    replayBoostTimeline: jsonb("replay_boost_timeline").$type<ReplayBoostTimeline>(),
    normalPhysicsConfirmed: boolean("normal_physics_confirmed"),
    verifiedState: integer("verified_state").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("leaderboard_track_user_unique").on(table.trackId, table.userId),
  ],
);

export const insertLeaderboardRecordSchema = createInsertSchema(
  leaderboardRecordsTable,
).omit({ id: true, createdAt: true });
export type LeaderboardRecord = typeof leaderboardRecordsTable.$inferSelect;
export type InsertLeaderboardRecord = z.infer<typeof insertLeaderboardRecordSchema>;