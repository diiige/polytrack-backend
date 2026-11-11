import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  db,
  leaderboardRecordsTable,
  type LeaderboardRecord,
  type ReplayBoostSettings,
  type ReplayBoostTimeline,
} from "@workspace/db";
import { UpdateLeaderboardNicknameResponse } from "@workspace/api-zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";

const router: IRouter = Router();
const dataDirectory =
  path.basename(process.cwd()) === "api-server"
    ? path.resolve(process.cwd(), "data")
    : path.resolve(process.cwd(), "artifacts/api-server/data");
const dataFile = path.join(dataDirectory, "leaderboard.json");
const maxFrames = 2_000_000;
const maxRecordingLength = 200_000;
const maxReplayBoostTimelineLength = 200_000;
const maxReplayBoostTimelineSegments = 10_000;

type LegacyRecord = {
  id: number;
  trackId: string;
  userId: string;
  nickname: string;
  countryCode: string | null;
  carStyle: string;
  frames: number;
  recording: string;
  verifiedState: number;
  createdAt: number;
  replayBoostSettings?: ReplayBoostSettings;
  replayBoostTimeline?: ReplayBoostTimeline;
  normalPhysicsConfirmed?: boolean;
};

let legacyImport: Promise<void> | undefined;

async function importLegacyRecords(): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(dataFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!Array.isArray(parsed)) throw new Error("Invalid legacy leaderboard file");
  for (const record of parsed.filter(isStoredRecord)) {
    await db.insert(leaderboardRecordsTable).values({
      trackId: record.trackId.toLowerCase(),
      userId: record.userId,
      nickname: record.nickname,
      countryCode: record.countryCode,
      carStyle: record.carStyle,
      frames: record.frames,
      recording: record.recording,
      replayBoostSettings: parseReplayBoostSettings(record.replayBoostSettings),
      replayBoostTimeline: parseReplayBoostTimeline(record.replayBoostTimeline),
      normalPhysicsConfirmed: record.normalPhysicsConfirmed === true ? true : null,
      verifiedState: record.verifiedState,
      createdAt: new Date(record.createdAt),
    }).onConflictDoNothing({
      target: [leaderboardRecordsTable.trackId, leaderboardRecordsTable.userId],
    });
  }
}

function isStoredRecord(value: unknown): value is LegacyRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<LegacyRecord>;
  return (
    Number.isSafeInteger(record.id) &&
    typeof record.trackId === "string" &&
    typeof record.userId === "string" &&
    typeof record.nickname === "string" &&
    (typeof record.countryCode === "string" || record.countryCode === null) &&
    typeof record.carStyle === "string" &&
    Number.isSafeInteger(record.frames) &&
    typeof record.recording === "string" &&
    Number.isSafeInteger(record.verifiedState) &&
    typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.createdAt) &&
    Number.isFinite(new Date(record.createdAt).getTime())
  );
}

async function ensureLegacyImported(): Promise<void> {
  legacyImport ??= importLegacyRecords().catch((error) => {
    legacyImport = undefined;
    throw error;
  });
  await legacyImport;
}

async function getTrackRecords(trackId: string): Promise<LeaderboardRecord[]> {
  await ensureLegacyImported();
  return db.select().from(leaderboardRecordsTable)
    .where(eq(leaderboardRecordsTable.trackId, trackId));
}

function sortedRecords(records: LeaderboardRecord[], trackId: string): LeaderboardRecord[] {
  return records
    .filter((record) => record.trackId === trackId)
    .sort((a, b) => a.frames - b.frames ||
      a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function parseInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseTrackId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function isBooleanValue(value: unknown): boolean {
  return value === true || value === false || value === "true" || value === "false" ||
    value === "1" || value === "0";
}

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const nickname = value.trim().slice(0, 32);
  return nickname.length > 0 ? nickname : null;
}

export function parseReplayBoostSettings(value: unknown): ReplayBoostSettings | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Invalid replay boost settings");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid replay boost settings");
  }
  const settings = value as Record<string, unknown>;
  const keys = ["accelerationMultiplier", "brakingMultiplier", "topSpeedMultiplier"] as const;
  if (Object.keys(settings).length !== keys.length ||
      keys.some((key) => typeof settings[key] !== "number" ||
        !Number.isFinite(settings[key]) || (settings[key] as number) < 1 ||
        (settings[key] as number) > 2) ||
      !keys.some((key) => (settings[key] as number) > 1)) {
    throw new Error("Invalid replay boost settings");
  }
  return {
    accelerationMultiplier: settings.accelerationMultiplier as number,
    brakingMultiplier: settings.brakingMultiplier as number,
    topSpeedMultiplier: settings.topSpeedMultiplier as number,
  };
}

function parseNormalPhysicsConfirmed(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return null;
  throw new Error("Invalid normal physics confirmation");
}

export function parseReplayBoostTimeline(value: unknown): ReplayBoostTimeline | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value.length > maxReplayBoostTimelineLength) {
      throw new Error("Invalid replay boost timeline");
    }
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Invalid replay boost timeline");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid replay boost timeline");
  }
  const timeline = value as Record<string, unknown>;
  if (timeline.version !== 1 || !Array.isArray(timeline.segments) ||
      timeline.segments.length < 1 ||
      timeline.segments.length > maxReplayBoostTimelineSegments) {
    throw new Error("Invalid replay boost timeline");
  }

  const segments: ReplayBoostTimeline["segments"] = [];
  let previousEndFrame = 0;
  let hasBoost = false;
  for (const value of timeline.segments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid replay boost timeline");
    }
    const segment = value as Record<string, unknown>;
    const keys = [
      "startFrame",
      "endFrame",
      "accelerationMultiplier",
      "brakingMultiplier",
      "topSpeedMultiplier",
    ] as const;
    if (Object.keys(segment).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(segment, key))) {
      throw new Error("Invalid replay boost timeline");
    }
    const { startFrame, endFrame } = segment;
    const values = [
      segment.accelerationMultiplier,
      segment.brakingMultiplier,
      segment.topSpeedMultiplier,
    ];
    if (!Number.isSafeInteger(startFrame) || (startFrame as number) < 1 ||
        !Number.isSafeInteger(endFrame) || (endFrame as number) < (startFrame as number) ||
        (endFrame as number) > maxFrames ||
        (startFrame as number) <= previousEndFrame ||
        values.some((multiplier) =>
          typeof multiplier !== "number" || !Number.isFinite(multiplier) ||
          multiplier < 1 || multiplier > 2
        )) {
      throw new Error("Invalid replay boost timeline");
    }
    previousEndFrame = endFrame as number;
    hasBoost ||= values.some((multiplier) =>
      typeof multiplier === "number" && multiplier > 1
    );
    segments.push({
      startFrame: startFrame as number,
      endFrame: endFrame as number,
      accelerationMultiplier: segment.accelerationMultiplier as number,
      brakingMultiplier: segment.brakingMultiplier as number,
      topSpeedMultiplier: segment.topSpeedMultiplier as number,
    });
  }
  if (!hasBoost) throw new Error("Invalid replay boost timeline");
  return { version: 1, segments };
}

function entry(record: LeaderboardRecord) {
  return {
    id: record.id,
    userId: record.userId,
    nickname: record.nickname,
    countryCode: record.countryCode,
    frames: record.frames,
    carStyle: record.carStyle,
    verifiedState: record.verifiedState,
  };
}

function userEntry(records: LeaderboardRecord[], trackId: string, userId: string) {
  const ranked = sortedRecords(records, trackId);
  const index = ranked.findIndex((record) => record.userId === userId);
  if (index < 0) return null;
  const record = ranked[index];
  return {
    position: index + 1,
    frames: record.frames,
    id: record.id,
    hasReplayBoostSettings:
      record.replayBoostSettings !== null || record.replayBoostTimeline !== null,
    hasReplayBoostTimeline: record.replayBoostTimeline !== null,
    hasConfirmedNormalPhysics: record.normalPhysicsConfirmed === true,
  };
}

router.get("/v6/leaderboard", async (req, res): Promise<void> => {
  const trackId = parseTrackId(req.query.trackId);
  const skip = parseInteger(req.query.skip) ?? 0;
  const amount = parseInteger(req.query.amount) ?? 20;
  if (
    trackId === null ||
    skip < 0 ||
    amount < 1 ||
    amount > 100 ||
    !isBooleanValue(req.query.onlyVerified)
  ) {
    res.status(400).json({ error: "Invalid leaderboard query" });
    return;
  }

  const records = await getTrackRecords(trackId);
  const ranked = sortedRecords(records, trackId);
  const matching = ranked;
  const userId =
    typeof req.query.userTokenHash === "string" ? req.query.userTokenHash : null;
  res.json({
    total: matching.length,
    entries: matching.slice(skip, skip + amount).map(entry),
    userEntry: userId ? userEntry(records, trackId, userId) : null,
  });
});

router.post("/v6/leaderboardNickname", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const rawNickname = typeof body.nickname === "string" ? body.nickname : "";
  const nickname = normalizeNickname(rawNickname);
  if (
    !nickname ||
    rawNickname.length > 32 ||
    userToken.length < 1 ||
    userToken.length > 4096
  ) {
    res.status(400).json({ error: "Invalid leaderboard nickname" });
    return;
  }

  const userId = createHash("sha256").update(userToken).digest("hex");
  await ensureLegacyImported();
  const updated = await db.update(leaderboardRecordsTable)
    .set({ nickname })
    .where(eq(leaderboardRecordsTable.userId, userId))
    .returning({ id: leaderboardRecordsTable.id });
  res.json(UpdateLeaderboardNicknameResponse.parse({ updatedRecords: updated.length }));
});

router.post("/v6/leaderboard", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  let replayBoostSettings: ReplayBoostSettings | null;
  let replayBoostTimeline: ReplayBoostTimeline | null;
  let normalPhysicsConfirmed: boolean | null;
  try {
    replayBoostSettings = parseReplayBoostSettings(body.replayBoostSettings);
  } catch {
    res.status(400).json({ error: "Invalid replay boost settings" });
    return;
  }
  try {
    replayBoostTimeline = parseReplayBoostTimeline(body.replayBoostTimeline);
  } catch {
    res.status(400).json({ error: "Invalid replay boost timeline" });
    return;
  }
  try {
    normalPhysicsConfirmed = parseNormalPhysicsConfirmed(body.normalPhysicsConfirmed);
  } catch {
    res.status(400).json({ error: "Invalid normal physics confirmation" });
    return;
  }
  const trackId = parseTrackId(body.trackId);
  const frames = parseInteger(body.frames);
  const nickname = normalizeNickname(body.nickname);
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const recording = typeof body.recording === "string" ? body.recording : "";
  const carStyle = typeof body.carStyle === "string" ? body.carStyle : "";
  if (
    trackId === null ||
    (body.onlyVerified !== undefined && !isBooleanValue(body.onlyVerified)) ||
    !nickname ||
    userToken.length < 1 ||
    userToken.length > 4096 ||
    carStyle.length < 1 ||
    carStyle.length > 4096 ||
    recording.length < 1 ||
    recording.length > maxRecordingLength ||
    frames === null ||
    frames < 1 ||
    frames > maxFrames
  ) {
    res.status(400).json({ error: "Invalid leaderboard record" });
    return;
  }

  const userId = createHash("sha256").update(userToken).digest("hex");
  await ensureLegacyImported();
  const result = await db.transaction(async (transaction) => {
    // A unique (track, user) constraint makes concurrent uploads safe, even
    // when requests reach different Autoscale instances.
    const previous = await transaction.select().from(leaderboardRecordsTable)
      .where(sql`${leaderboardRecordsTable.trackId} = ${trackId} AND ${leaderboardRecordsTable.userId} = ${userId}`);
    const rankedBefore = sortedRecords(
      await transaction.select().from(leaderboardRecordsTable)
        .where(eq(leaderboardRecordsTable.trackId, trackId)),
      trackId,
    );
    const updated = await transaction.insert(leaderboardRecordsTable).values({
      trackId,
      userId,
      nickname,
      countryCode: typeof body.countryCode === "string"
        ? body.countryCode.slice(0, 8) : null,
      carStyle,
      frames,
      recording,
      replayBoostSettings,
      replayBoostTimeline,
      normalPhysicsConfirmed,
      verifiedState: 0,
    }).onConflictDoUpdate({
      target: [leaderboardRecordsTable.trackId, leaderboardRecordsTable.userId],
      set: {
        nickname,
        countryCode: typeof body.countryCode === "string"
          ? body.countryCode.slice(0, 8) : null,
        carStyle,
        frames,
        recording,
        replayBoostSettings,
        replayBoostTimeline,
        normalPhysicsConfirmed,
        verifiedState: 0,
        createdAt: new Date(),
      },
      setWhere: sql`excluded.frames < ${leaderboardRecordsTable.frames} OR
        (excluded.frames = ${leaderboardRecordsTable.frames} AND
         excluded.recording = ${leaderboardRecordsTable.recording} AND
         ((${leaderboardRecordsTable.replayBoostSettings} IS NULL AND
           excluded.replay_boost_settings IS NOT NULL) OR
          (${leaderboardRecordsTable.replayBoostTimeline} IS NULL AND
            excluded.replay_boost_timeline IS NOT NULL) OR
          (${leaderboardRecordsTable.normalPhysicsConfirmed} IS NULL AND
            excluded.normal_physics_confirmed IS NOT NULL)))`,
    }).returning();
    const current = updated[0] ?? previous[0] ??
      (await transaction.select().from(leaderboardRecordsTable)
        .where(sql`${leaderboardRecordsTable.trackId} = ${trackId} AND ${leaderboardRecordsTable.userId} = ${userId}`))[0];
    const rankedAfter = sortedRecords(
      await transaction.select().from(leaderboardRecordsTable)
        .where(eq(leaderboardRecordsTable.trackId, trackId)),
      trackId,
    );
    return {
      uploadId: current.id,
      previousPosition: previous[0]
        ? rankedBefore.findIndex((item) => item.id === previous[0].id) + 1
        : 0,
      newPosition: rankedAfter.findIndex((item) => item.id === current.id) + 1,
    };
  });
  res.json(result);
});

router.delete("/v6/leaderboard", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const trackId = parseTrackId(body.trackId);
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  if (trackId === null || userToken.length < 1 || userToken.length > 4096) {
    res.status(400).json({ error: "Invalid leaderboard deletion" });
    return;
  }

  const userId = createHash("sha256").update(userToken).digest("hex");
  await ensureLegacyImported();
  const deleted = await db.delete(leaderboardRecordsTable)
    .where(and(
      eq(leaderboardRecordsTable.trackId, trackId),
      eq(leaderboardRecordsTable.userId, userId),
    ))
    .returning({ id: leaderboardRecordsTable.id });
  res.json({ deletedRecords: deleted.length });
});

router.get("/v6/leaderboardUserEntry", async (req, res): Promise<void> => {
  const trackId = parseTrackId(req.query.trackId);
  const { userTokenHash } = req.query;
  if (
    trackId === null ||
    typeof userTokenHash !== "string" ||
    !isBooleanValue(req.query.onlyVerified)
  ) {
    res.status(400).json({ error: "Invalid leaderboard lookup" });
    return;
  }
  const records = await getTrackRecords(trackId);
  res.json(userEntry(records, trackId, userTokenHash));
});

router.get("/v6/recordings", async (req, res): Promise<void> => {
  const ids =
    typeof req.query.ids === "string"
      ? req.query.ids
          .split(",")
          .map((value) => parseInteger(value))
          .filter((value): value is number => value !== null)
      : [];
  await ensureLegacyImported();
  const records = ids.length > 0
    ? await db.select().from(leaderboardRecordsTable)
      .where(inArray(leaderboardRecordsTable.id, ids))
    : [];
  res.json(
    ids.map((id) => {
      const record = records.find((item) => item.id === id);
      return record
        ? {
            recording: record.recording,
            verifiedState: record.verifiedState,
            frames: record.frames,
            carStyle: record.carStyle,
            ...(record.replayBoostSettings ? { replayBoostSettings: record.replayBoostSettings } : {}),
            ...(record.replayBoostTimeline
              ? { replayBoostTimeline: record.replayBoostTimeline }
              : {}),
            ...(record.normalPhysicsConfirmed
              ? { normalPhysicsConfirmed: true }
              : {}),
          }
        : null;
    }),
  );
});

router.post("/v6/user", (_req, res) => {
  res.status(204).end();
});

export default router;