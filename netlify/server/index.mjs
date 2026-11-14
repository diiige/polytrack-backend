// Leaderboard and Track of the Week API for PolyTrack, served under /api/v6/*.
// Port of artifacts/api-server/src/routes/{leaderboard,track-of-the-week}.ts onto Netlify Database.
import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { communityTrackImports } from "./track-catalog.mjs";

// Only API paths reach this server; the static PolyTrack build is served from the publish directory.
export const config = { path: "/api/v6/*" };

const db = getDatabase();

const MAX_FRAMES = 2_000_000;
const MAX_RECORDING_LENGTH = 200_000;
const MAX_REPLAY_BOOST_TIMELINE_LENGTH = 200_000;
const MAX_REPLAY_BOOST_TIMELINE_SEGMENTS = 10_000;
const MAX_TOKEN_LENGTH = 4096;
const SUPPORTED_TRACK_OF_THE_WEEK_VERSION = "0.6.3";

const UPSERT_RECORD_SQL = `
  INSERT INTO leaderboard_records (
    track_id, user_id, nickname, country_code, car_style, frames, recording,
    replay_boost_settings, replay_boost_timeline, normal_physics_confirmed, verified_state
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 0)
  ON CONFLICT (track_id, user_id) DO UPDATE SET
    nickname = EXCLUDED.nickname,
    country_code = EXCLUDED.country_code,
    car_style = EXCLUDED.car_style,
    frames = EXCLUDED.frames,
    recording = EXCLUDED.recording,
    replay_boost_settings = EXCLUDED.replay_boost_settings,
    replay_boost_timeline = EXCLUDED.replay_boost_timeline,
    normal_physics_confirmed = EXCLUDED.normal_physics_confirmed,
    verified_state = 0,
    created_at = NOW()
  WHERE EXCLUDED.frames < leaderboard_records.frames OR
    (EXCLUDED.frames = leaderboard_records.frames AND
     EXCLUDED.recording = leaderboard_records.recording AND
     ((leaderboard_records.replay_boost_settings IS NULL AND EXCLUDED.replay_boost_settings IS NOT NULL) OR
      (leaderboard_records.replay_boost_timeline IS NULL AND EXCLUDED.replay_boost_timeline IS NOT NULL) OR
      (leaderboard_records.normal_physics_confirmed IS NULL AND EXCLUDED.normal_physics_confirmed IS NOT NULL)))
  RETURNING id
`;

// Ranking order matches the Replit leaderboard: fastest frames first, then earliest submission.
const RANKED_ROWS_SQL = `
  SELECT id, user_id, nickname, country_code, car_style, frames, verified_state,
         normal_physics_confirmed, created_at,
         (replay_boost_settings IS NOT NULL) AS has_replay_boost_settings,
         (replay_boost_timeline IS NOT NULL) AS has_replay_boost_timeline
  FROM leaderboard_records
  WHERE track_id = $1
  ORDER BY frames ASC, created_at ASC, id ASC
`;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function badRequest(message) {
  return json({ error: message }, 400);
}

// Query parameters that are absent are passed as undefined so they fall back to defaults.
function param(url, name) {
  return url.searchParams.get(name) ?? undefined;
}

function parseInteger(value) {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseTrackId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

function isBooleanValue(value) {
  return value === true || value === false || value === "true" || value === "false" ||
    value === "1" || value === "0";
}

function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const nickname = value.trim().slice(0, 32);
  return nickname.length > 0 ? nickname : null;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// Form posts (multipart or urlencoded) and JSON bodies are both accepted, as the Replit server did.
async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = await request.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    if (contentType.includes("multipart/form-data") ||
        contentType.includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries((await request.formData()).entries());
    }
  } catch {
    return {};
  }
  return {};
}

function parseReplayBoostSettings(value) {
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
  const keys = ["accelerationMultiplier", "brakingMultiplier", "topSpeedMultiplier"];
  if (Object.keys(value).length !== keys.length ||
      keys.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]) ||
        value[key] < 1 || value[key] > 2) ||
      !keys.some((key) => value[key] > 1)) {
    throw new Error("Invalid replay boost settings");
  }
  return {
    accelerationMultiplier: value.accelerationMultiplier,
    brakingMultiplier: value.brakingMultiplier,
    topSpeedMultiplier: value.topSpeedMultiplier,
  };
}

function parseNormalPhysicsConfirmed(value) {
  if (value === undefined || value === null) return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return null;
  throw new Error("Invalid normal physics confirmation");
}

function parseReplayBoostTimeline(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value.length > MAX_REPLAY_BOOST_TIMELINE_LENGTH) {
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
  if (value.version !== 1 || !Array.isArray(value.segments) ||
      value.segments.length < 1 ||
      value.segments.length > MAX_REPLAY_BOOST_TIMELINE_SEGMENTS) {
    throw new Error("Invalid replay boost timeline");
  }

  const keys = ["startFrame", "endFrame", "accelerationMultiplier", "brakingMultiplier", "topSpeedMultiplier"];
  const segments = [];
  let previousEndFrame = 0;
  let hasBoost = false;
  for (const segment of value.segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      throw new Error("Invalid replay boost timeline");
    }
    if (Object.keys(segment).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(segment, key))) {
      throw new Error("Invalid replay boost timeline");
    }
    const { startFrame, endFrame } = segment;
    const multipliers = [
      segment.accelerationMultiplier,
      segment.brakingMultiplier,
      segment.topSpeedMultiplier,
    ];
    if (!Number.isSafeInteger(startFrame) || startFrame < 1 ||
        !Number.isSafeInteger(endFrame) || endFrame < startFrame ||
        endFrame > MAX_FRAMES ||
        startFrame <= previousEndFrame ||
        multipliers.some((multiplier) =>
          typeof multiplier !== "number" || !Number.isFinite(multiplier) ||
          multiplier < 1 || multiplier > 2
        )) {
      throw new Error("Invalid replay boost timeline");
    }
    previousEndFrame = endFrame;
    hasBoost ||= multipliers.some((multiplier) => multiplier > 1);
    segments.push({
      startFrame,
      endFrame,
      accelerationMultiplier: segment.accelerationMultiplier,
      brakingMultiplier: segment.brakingMultiplier,
      topSpeedMultiplier: segment.topSpeedMultiplier,
    });
  }
  if (!hasBoost) throw new Error("Invalid replay boost timeline");
  return { version: 1, segments };
}

// Ranks every record on a track. Accepts a pool or a transaction client.
async function rankRows(queryable, trackId) {
  const { rows } = await queryable.query(RANKED_ROWS_SQL, [trackId]);
  return rows;
}

function entryFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    countryCode: row.country_code,
    frames: row.frames,
    carStyle: row.car_style,
    verifiedState: row.verified_state,
  };
}

function userEntryFromRanked(ranked, userId) {
  const index = ranked.findIndex((row) => row.user_id === userId);
  if (index < 0) return null;
  const row = ranked[index];
  return {
    position: index + 1,
    frames: row.frames,
    id: row.id,
    hasReplayBoostSettings: row.has_replay_boost_settings || row.has_replay_boost_timeline,
    hasReplayBoostTimeline: row.has_replay_boost_timeline,
    hasConfirmedNormalPhysics: row.normal_physics_confirmed === true,
  };
}

async function handleGetLeaderboard(url) {
  const trackId = parseTrackId(param(url, "trackId"));
  const skip = parseInteger(param(url, "skip")) ?? 0;
  const amount = parseInteger(param(url, "amount")) ?? 20;
  const onlyVerified = param(url, "onlyVerified");
  if (trackId === null || skip < 0 || amount < 1 || amount > 100 ||
      (onlyVerified !== undefined && !isBooleanValue(onlyVerified))) {
    return badRequest("Invalid leaderboard query");
  }

  const ranked = await rankRows(db.pool, trackId);
  const userTokenHash = param(url, "userTokenHash");
  return json({
    total: ranked.length,
    entries: ranked.slice(skip, skip + amount).map(entryFromRow),
    userEntry: userTokenHash ? userEntryFromRanked(ranked, userTokenHash) : null,
  });
}

async function handlePostLeaderboard(request) {
  const body = await readBody(request);
  let replayBoostSettings;
  let replayBoostTimeline;
  let normalPhysicsConfirmed;
  try {
    replayBoostSettings = parseReplayBoostSettings(body.replayBoostSettings);
  } catch {
    return badRequest("Invalid replay boost settings");
  }
  try {
    replayBoostTimeline = parseReplayBoostTimeline(body.replayBoostTimeline);
  } catch {
    return badRequest("Invalid replay boost timeline");
  }
  try {
    normalPhysicsConfirmed = parseNormalPhysicsConfirmed(body.normalPhysicsConfirmed);
  } catch {
    return badRequest("Invalid normal physics confirmation");
  }

  const trackId = parseTrackId(body.trackId);
  const frames = parseInteger(body.frames);
  const nickname = normalizeNickname(body.nickname);
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const recording = typeof body.recording === "string" ? body.recording : "";
  const carStyle = typeof body.carStyle === "string" ? body.carStyle : "";
  if (trackId === null ||
      (body.onlyVerified !== undefined && !isBooleanValue(body.onlyVerified)) ||
      !nickname ||
      userToken.length < 1 || userToken.length > MAX_TOKEN_LENGTH ||
      carStyle.length < 1 || carStyle.length > MAX_TOKEN_LENGTH ||
      recording.length < 1 || recording.length > MAX_RECORDING_LENGTH ||
      frames === null || frames < 1 || frames > MAX_FRAMES) {
    return badRequest("Invalid leaderboard record");
  }

  const userId = hashToken(userToken);
  const countryCode = typeof body.countryCode === "string" ? body.countryCode.slice(0, 8) : null;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const previous = (await client.query(
      "SELECT id FROM leaderboard_records WHERE track_id = $1 AND user_id = $2",
      [trackId, userId],
    )).rows[0] ?? null;
    const rankedBefore = await rankRows(client, trackId);
    const upserted = await client.query(UPSERT_RECORD_SQL, [
      trackId,
      userId,
      nickname,
      countryCode,
      carStyle,
      frames,
      recording,
      replayBoostSettings ? JSON.stringify(replayBoostSettings) : null,
      replayBoostTimeline ? JSON.stringify(replayBoostTimeline) : null,
      normalPhysicsConfirmed,
    ]);
    const currentId = upserted.rows[0]?.id ?? previous?.id;
    const rankedAfter = await rankRows(client, trackId);
    await client.query("COMMIT");

    return json({
      uploadId: currentId,
      previousPosition: previous ? rankedBefore.findIndex((row) => row.id === previous.id) + 1 : 0,
      newPosition: rankedAfter.findIndex((row) => row.id === currentId) + 1,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handlePostLeaderboardNickname(request) {
  const body = await readBody(request);
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const rawNickname = typeof body.nickname === "string" ? body.nickname : "";
  const nickname = normalizeNickname(rawNickname);
  if (!nickname || rawNickname.length > 32 ||
      userToken.length < 1 || userToken.length > MAX_TOKEN_LENGTH) {
    return badRequest("Invalid leaderboard nickname");
  }

  const result = await db.pool.query(
    "UPDATE leaderboard_records SET nickname = $1 WHERE user_id = $2",
    [nickname, hashToken(userToken)],
  );
  return json({ updatedRecords: result.rowCount ?? 0 });
}

async function handleDeleteLeaderboard(request) {
  const body = await readBody(request);
  const trackId = parseTrackId(body.trackId);
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  if (trackId === null || userToken.length < 1 || userToken.length > MAX_TOKEN_LENGTH) {
    return badRequest("Invalid leaderboard deletion");
  }

  const result = await db.pool.query(
    "DELETE FROM leaderboard_records WHERE track_id = $1 AND user_id = $2",
    [trackId, hashToken(userToken)],
  );
  return json({ deletedRecords: result.rowCount ?? 0 });
}

async function handleGetUserEntry(url) {
  const trackId = parseTrackId(param(url, "trackId"));
  const userTokenHash = param(url, "userTokenHash");
  const onlyVerified = param(url, "onlyVerified");
  if (trackId === null || typeof userTokenHash !== "string" ||
      (onlyVerified !== undefined && !isBooleanValue(onlyVerified))) {
    return badRequest("Invalid leaderboard lookup");
  }
  const ranked = await rankRows(db.pool, trackId);
  return json(userEntryFromRanked(ranked, userTokenHash));
}

async function handleGetRecordings(url) {
  const raw = param(url, "ids");
  const ids = typeof raw === "string"
    ? raw.split(",").map((value) => parseInteger(value)).filter((value) => value !== null)
    : [];
  if (ids.length === 0) return json([]);

  const { rows } = await db.pool.query(
    `SELECT id, recording, verified_state, frames, car_style,
            replay_boost_settings, replay_boost_timeline, normal_physics_confirmed
     FROM leaderboard_records WHERE id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return json(ids.map((id) => {
    const row = byId.get(id);
    if (!row) return null;
    return {
      recording: row.recording,
      verifiedState: row.verified_state,
      frames: row.frames,
      carStyle: row.car_style,
      ...(row.replay_boost_settings ? { replayBoostSettings: row.replay_boost_settings } : {}),
      ...(row.replay_boost_timeline ? { replayBoostTimeline: row.replay_boost_timeline } : {}),
      ...(row.normal_physics_confirmed ? { normalPhysicsConfirmed: true } : {}),
    };
  }));
}

// Weekly featured map. Mirrors artifacts/api-server/src/lib/track-of-the-week.ts.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Anchored to a UTC Monday so local timezone settings never change the rotation.
const FIRST_MONDAY_UTC = Date.UTC(1970, 0, 5);
const ENVIRONMENT_NUMBERS = { Summer: 1, Winter: 2, Desert: 3 };

function trackOfTheWeek(now = new Date()) {
  const currentTime = now.getTime();
  const weekNumber = Math.floor((currentTime - FIRST_MONDAY_UTC) / WEEK_MS);
  const count = communityTrackImports.length;
  const track = communityTrackImports[((weekNumber % count) + count) % count];
  const endTime = new Date(FIRST_MONDAY_UTC + (weekNumber + 1) * WEEK_MS);
  return {
    serverTime: now.toISOString(),
    current: {
      trackId: track.id,
      name: track.name,
      author: track.author,
      lastModified: track.lastModified,
      environment: ENVIRONMENT_NUMBERS[track.environment],
      thumbnailUrl: `/main/tracks/community/thumbnails/${track.assetFile.replace(/\.track$/, ".png")}`,
      coverUrl: null,
      trackUrl: `/main/tracks/community/${track.assetFile}`,
      endTime: endTime.toISOString(),
    },
  };
}

function handleTrackOfTheWeek(url) {
  if (param(url, "version") !== SUPPORTED_TRACK_OF_THE_WEEK_VERSION) {
    return badRequest("Unsupported PolyTrack version");
  }
  return json(trackOfTheWeek());
}

export default async (request) => {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  try {
    if (pathname === "/api/v6/leaderboard") {
      if (method === "GET") return await handleGetLeaderboard(url);
      if (method === "POST") return await handlePostLeaderboard(request);
      if (method === "DELETE") return await handleDeleteLeaderboard(request);
    }
    if (pathname === "/api/v6/leaderboardNickname" && method === "POST") {
      return await handlePostLeaderboardNickname(request);
    }
    if (pathname === "/api/v6/leaderboardUserEntry" && method === "GET") {
      return await handleGetUserEntry(url);
    }
    if (pathname === "/api/v6/recordings" && method === "GET") {
      return await handleGetRecordings(url);
    }
    if (pathname === "/api/v6/trackOfTheWeek" && method === "GET") {
      return handleTrackOfTheWeek(url);
    }
    if (pathname === "/api/v6/user" && method === "POST") {
      return new Response(null, { status: 204 });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Leaderboard request failed:", pathname, error);
    return json({ error: "Leaderboard request failed" }, 500);
  }
};
