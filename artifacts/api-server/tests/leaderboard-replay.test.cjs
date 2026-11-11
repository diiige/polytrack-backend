const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");

const base = process.env.TEST_API_BASE_URL || "http://localhost:80/api";
const maxRecordingLength = 200_000;
const maxReplayBoostTimelineLength = 200_000;

function createNearLimitTimeline() {
  const prefix = '{"version":1,"segments":[';
  const suffix = "]}";
  const segments = [];
  let length = prefix.length + suffix.length;
  while (true) {
    const frame = segments.length + 1;
    const segment = {
      startFrame: frame,
      endFrame: frame,
      accelerationMultiplier: 1.7,
      brakingMultiplier: 1.3,
      topSpeedMultiplier: 1.2,
    };
    const segmentLength = JSON.stringify(segment).length + (segments.length > 0 ? 1 : 0);
    if (length + segmentLength > maxReplayBoostTimelineLength - 8) break;
    segments.push(segment);
    length += segmentLength;
  }

  const timeline = { version: 1, segments };
  const serialized = JSON.stringify(timeline);
  assert.ok(serialized.length <= maxReplayBoostTimelineLength);
  assert.ok(
    serialized.length > maxReplayBoostTimelineLength - 256,
    `Expected a near-limit timeline, got ${serialized.length} characters`,
  );
  return { timeline, serialized };
}

test("leaderboard preserves boosted, confirmed-normal, and legacy-unmarked replay metadata", async () => {
  const trackId = createHash("sha256").update(randomUUID()).digest("hex");
  const boost = {
    accelerationMultiplier: 1.7,
    brakingMultiplier: 1.3,
    topSpeedMultiplier: 1.2,
  };
  const timeline = {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 70, ...boost },
      {
        startFrame: 71, endFrame: 120,
        accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1,
      },
    ],
  };
  const submit = async (
    userToken, frames, recording, replayBoostSettings, replayBoostTimeline,
    normalPhysicsConfirmed,
  ) => {
    const form = new URLSearchParams({
      version: "v6", userToken, nickname: "Replay test",
      carStyle: "default", trackId, frames: String(frames), recording,
      onlyVerified: "true",
    });
    if (replayBoostSettings !== undefined) {
      form.set("replayBoostSettings", replayBoostSettings);
    }
    if (replayBoostTimeline !== undefined) {
      form.set("replayBoostTimeline", replayBoostTimeline);
    }
    if (normalPhysicsConfirmed !== undefined) {
      form.set("normalPhysicsConfirmed", String(normalPhysicsConfirmed));
    }
    return fetch(`${base}/v6/leaderboard`, { method: "POST", body: form });
  };
  const boosted = await submit(
    "boost-" + trackId, 120, "boosted-controls", JSON.stringify(boost), JSON.stringify(timeline),
  );
  assert.equal(boosted.status, 200);
  const { uploadId: boostedId } = await boosted.json();
  const normal = await submit("normal-" + trackId, 150, "ordinary-controls");
  assert.equal(normal.status, 200);
  const { uploadId: normalId } = await normal.json();
  const confirmedNormal = await submit(
    "confirmed-normal-" + trackId, 160, "new-normal-controls",
    undefined, undefined, true,
  );
  assert.equal(confirmedNormal.status, 200);
  const { uploadId: confirmedNormalId } = await confirmedNormal.json();

  for (const invalid of [
    "{", JSON.stringify({ ...boost, accelerationMultiplier: 50 }),
    JSON.stringify({ accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 }),
    JSON.stringify({ ...boost, extra: true }),
  ]) {
    assert.equal((await submit("bad-" + randomUUID(), 90, "invalid", invalid)).status, 400);
  }
  assert.equal((await submit(
    "bad-timeline-" + randomUUID(), 90, "invalid", undefined,
    JSON.stringify({ version: 1, segments: [{ ...timeline.segments[0], startFrame: 0 }] }),
  )).status, 400);

  const recordings = async () => {
    const response = await fetch(
      `${base}/v6/recordings?ids=${boostedId},${normalId},${confirmedNormalId}`,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  let [marked, unmarked, normalMarked] = await recordings();
  assert.deepEqual(marked.replayBoostSettings, boost);
  assert.deepEqual(marked.replayBoostTimeline, timeline);
  assert.equal(Object.hasOwn(unmarked, "replayBoostSettings"), false);
  assert.equal(Object.hasOwn(unmarked, "normalPhysicsConfirmed"), false,
    "legacy-style records without the marker remain unmarked");
  assert.equal(normalMarked.normalPhysicsConfirmed, true,
    "explicit normal provenance is returned with the replay");
  const pageResponse = await fetch(
    `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=20&onlyVerified=false`,
  );
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.total, 3);
  assert.equal(page.entries.length, 3);
  for (const record of page.entries) {
    assert.equal(
      Object.hasOwn(record, "replayBoostStatus"), false,
      "public leaderboard entries do not disclose replay boost classification",
    );
  }
  for (const status of ["boosted", "not-boosted", "unknown"]) {
    const filteredResponse = await fetch(
      `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=20&onlyVerified=false&replayBoostStatus=${status}`,
    );
    assert.equal(filteredResponse.status, 200);
    const filteredPage = await filteredResponse.json();
    assert.equal(filteredPage.total, 3);
    assert.deepEqual(
      filteredPage.entries.map((record) => record.userId),
      page.entries.map((record) => record.userId),
      "old filter queries cannot hide public leaderboard entries",
    );
  }
  const filteredFirstPage = await (await fetch(
    `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=1&onlyVerified=false&replayBoostStatus=unknown`,
  )).json();
  assert.equal(filteredFirstPage.total, 3);
  assert.equal(filteredFirstPage.entries[0].userId, page.entries[0].userId);

  const normalBackfill = await submit(
    "normal-" + trackId, 150, "ordinary-controls", undefined, undefined, true,
  );
  assert.equal(normalBackfill.status, 200);
  [, unmarked] = await recordings();
  assert.equal(unmarked.normalPhysicsConfirmed, true,
    "the API can backfill confirmation for the identical saved recording");
  const backfilledPage = await (await fetch(
    `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=20&onlyVerified=false`,
  )).json();
  assert.ok(backfilledPage.entries.every((record) => !Object.hasOwn(record, "replayBoostStatus")),
    "metadata backfills remain private");
  const noLongerUnknown = await fetch(
    `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=20&onlyVerified=false&replayBoostStatus=unknown`,
  );
  assert.equal((await noLongerUnknown.json()).total, 3,
    "private metadata does not change the public leaderboard total");

  const replaced = await submit("normal-" + trackId, 140, "new-boosted-controls", JSON.stringify(boost));
  assert.equal(replaced.status, 200);
  [marked, unmarked, normalMarked] = await recordings();
  assert.deepEqual(unmarked.replayBoostSettings, boost, "a faster PB replaces the metadata with its run");
  assert.equal(unmarked.recording, "new-boosted-controls");
  assert.equal(normalMarked.normalPhysicsConfirmed, true,
    "a faster PB for another player does not erase its marker");

  const older = await submit("normal-" + trackId, 160, "slow-ordinary-controls");
  assert.equal(older.status, 200);
  [, unmarked] = await recordings();
  assert.equal(unmarked.recording, "new-boosted-controls", "a slower upload cannot erase metadata");

  const backfill = await submit("boost-" + trackId, 120, "boosted-controls", JSON.stringify(boost));
  assert.equal(backfill.status, 200);
  const lookup = await fetch(`${base}/v6/leaderboardUserEntry?trackId=${trackId}&userTokenHash=${
    createHash("sha256").update("boost-" + trackId).digest("hex")
  }&onlyVerified=true`);
  const lookupEntry = await lookup.json();
  assert.equal(lookupEntry.hasReplayBoostSettings, true);
  assert.equal(lookupEntry.hasReplayBoostTimeline, true);
});

test("public leaderboard pagination includes all records without replay labels", async () => {
  const trackId = createHash("sha256").update(randomUUID()).digest("hex");
  const boost = {
    accelerationMultiplier: 1.5,
    brakingMultiplier: 1,
    topSpeedMultiplier: 1.2,
  };
  const expectedPerStatus = 161;
  let sequence = 0;
  const seededUserIds = new Map();

  for (const status of ["boosted", "not-boosted", "unknown"]) {
    const userIds = [];
    for (let index = 0; index < expectedPerStatus; index += 1) {
      const userToken = `filter-page-${status}-${index}-${randomUUID()}`;
      const form = new URLSearchParams({
        version: "v6",
        userToken,
        nickname: `Filter ${status} ${index + 1}`,
        carStyle: "default",
        trackId,
        frames: String(100 + sequence),
        recording: `filter-page-${status}-${index}`,
        onlyVerified: "true",
      });
      if (status === "boosted") {
        form.set("replayBoostSettings", JSON.stringify(boost));
      } else if (status === "not-boosted") {
        form.set("normalPhysicsConfirmed", "true");
      }

      const response = await fetch(`${base}/v6/leaderboard`, {
        method: "POST",
        body: form,
      });
      assert.equal(response.status, 200, `could not seed ${status} record ${index + 1}`);
      userIds.push(createHash("sha256").update(userToken).digest("hex"));
      sequence += 1;
    }
    seededUserIds.set(status, userIds);
  }

  const expectedTotal = expectedPerStatus * 3;
  const pagedUserIds = [];
  for (const skip of Array.from(
    { length: Math.ceil(expectedTotal / 20) },
    (_, pageIndex) => pageIndex * 20,
  )) {
    const response = await fetch(
      `${base}/v6/leaderboard?trackId=${trackId}&skip=${skip}&amount=20&onlyVerified=false`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, expectedTotal,
      "every page reports the full leaderboard total");
    assert.equal(page.entries.length, Math.min(20, expectedTotal - skip),
      `the unfiltered leaderboard returns the expected entries at offset ${skip}`);
    assert.ok(page.entries.every((record) =>
      !Object.hasOwn(record, "replayBoostStatus")),
    "public pages do not disclose replay classification");
    pagedUserIds.push(...page.entries.map((record) => record.userId));
  }
  const allSeededUserIds = [...seededUserIds.values()].flat();
  assert.equal(new Set(pagedUserIds).size, expectedPerStatus * 3,
    "unfiltered pages do not repeat or miss entries");
  assert.deepEqual(new Set(pagedUserIds), new Set(allSeededUserIds),
    "unfiltered pages contain every seeded record");

});

test("an existing unmarked run can be backfilled only with its matching recording", async () => {
  const trackId = createHash("sha256").update(randomUUID()).digest("hex");
  const boost = JSON.stringify({
    accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
  });
  const timeline = JSON.stringify({
    version: 1,
    segments: [{
      startFrame: 1, endFrame: 100,
      accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
    }],
  });
  const submit = (recording, settings, boostTimeline) => {
    const form = new URLSearchParams({
      version: "v6", userToken: trackId, nickname: "Driver",
      carStyle: "default", trackId, frames: "100", recording,
    });
    if (settings) form.set("replayBoostSettings", settings);
    if (boostTimeline) form.set("replayBoostTimeline", boostTimeline);
    return fetch(`${base}/v6/leaderboard`, { method: "POST", body: form });
  };
  const { uploadId } = await (await submit("same-controls")).json();
  assert.equal((await submit("other-controls", boost, timeline)).status, 200);
  let result = await (await fetch(`${base}/v6/recordings?ids=${uploadId}`)).json();
  assert.equal(result[0].replayBoostSettings, undefined);
  assert.equal((await submit("same-controls", boost, timeline)).status, 200);
  result = await (await fetch(`${base}/v6/recordings?ids=${uploadId}`)).json();
  assert.deepEqual(result[0].replayBoostSettings, JSON.parse(boost));
  assert.deepEqual(result[0].replayBoostTimeline, JSON.parse(timeline));
});

test("near-limit boosted replay uploads preserve recording and timeline metadata", async () => {
  const trackId = createHash("sha256").update(randomUUID()).digest("hex");
  const userToken = "near-limit-" + trackId;
  const { timeline, serialized: timelineJson } = createNearLimitTimeline();
  const recording = "x".repeat(maxRecordingLength);
  const boost = {
    accelerationMultiplier: 1.7,
    brakingMultiplier: 1.3,
    topSpeedMultiplier: 1.2,
  };
  const form = new URLSearchParams({
    version: "v6",
    userToken,
    nickname: "Boundary test",
    carStyle: "default",
    trackId,
    frames: String(timeline.segments.length),
    recording,
    onlyVerified: "true",
    replayBoostSettings: JSON.stringify(boost),
    replayBoostTimeline: timelineJson,
  });
  assert.ok(
    form.toString().length < 1_000_000,
    "the maximum supported replay and timeline should fit the URL-encoded request limit",
  );

  const uploaded = await fetch(`${base}/v6/leaderboard`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const { uploadId } = await uploaded.json();

  const downloaded = await fetch(`${base}/v6/recordings?ids=${uploadId}`);
  assert.equal(downloaded.status, 200);
  const [result] = await downloaded.json();
  assert.equal(result.recording, recording);
  assert.deepEqual(result.replayBoostSettings, boost);
  assert.deepEqual(result.replayBoostTimeline, timeline);
});

test("oversized and malformed replay timelines return clear API errors", async () => {
  const trackId = createHash("sha256").update(randomUUID()).digest("hex");
  const { serialized } = createNearLimitTimeline();
  const submit = (userToken, replayBoostTimeline) => {
    const form = new URLSearchParams({
      version: "v6",
      userToken,
      nickname: "Invalid timeline",
      carStyle: "default",
      trackId,
      frames: "100",
      recording: "valid-controls",
      replayBoostTimeline,
    });
    return fetch(`${base}/v6/leaderboard`, { method: "POST", body: form });
  };

  for (const timeline of [
    "{",
    serialized + " ".repeat(maxReplayBoostTimelineLength - serialized.length + 1),
  ]) {
    const response = await submit("invalid-" + randomUUID(), timeline);
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await response.json(), { error: "Invalid replay boost timeline" });
  }

  const oversizedReplay = await submit(
    "oversized-replay-" + randomUUID(),
    "x".repeat(1_100_000),
  );
  assert.equal(oversizedReplay.status, 413);
  assert.match(oversizedReplay.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await oversizedReplay.json(), { error: "Request body too large" });

  const oversizedRecording = new URLSearchParams({
    version: "v6",
    userToken: "oversized-recording-" + randomUUID(),
    nickname: "Invalid recording",
    carStyle: "default",
    trackId,
    frames: "100",
    recording: "x".repeat(maxRecordingLength + 1),
  });
  const recordingResponse = await fetch(`${base}/v6/leaderboard`, {
    method: "POST",
    body: oversizedRecording,
  });
  assert.equal(recordingResponse.status, 400);
  assert.deepEqual(await recordingResponse.json(), { error: "Invalid leaderboard record" });
});

test("changing a profile name updates its existing leaderboard records only", async () => {
  const userToken = `rename-${randomUUID()}`;
  const otherToken = `other-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(userToken).digest("hex");
  const trackIds = [randomUUID(), randomUUID()].map((value) =>
    createHash("sha256").update(value).digest("hex"),
  );

  const submitRecord = async (token, trackId, nickname) => {
    const form = new URLSearchParams({
      version: "v6",
      userToken: token,
      nickname,
      carStyle: "default",
      trackId,
      frames: "100",
      recording: `controls-${trackId}`,
    });
    return fetch(`${base}/v6/leaderboard`, { method: "POST", body: form });
  };
  assert.equal((await submitRecord(userToken, trackIds[0], "Anonymous")).status, 200);
  assert.equal((await submitRecord(userToken, trackIds[1], "Anonymous")).status, 200);
  assert.equal((await submitRecord(otherToken, trackIds[0], "Other Driver")).status, 200);

  const updated = await fetch(`${base}/v6/leaderboardNickname`, {
    method: "POST",
    body: new URLSearchParams({ userToken, nickname: "Fast Driver" }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { updatedRecords: 2 });

  for (const trackId of trackIds) {
    const response = await fetch(
      `${base}/v6/leaderboard?trackId=${trackId}&skip=0&amount=20&onlyVerified=false`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    const ownEntry = page.entries.find((entry) => entry.userId === tokenHash);
    assert.equal(ownEntry.nickname, "Fast Driver");
    if (trackId === trackIds[0]) {
      assert.equal(
        page.entries.find((entry) => entry.nickname === "Other Driver").nickname,
        "Other Driver",
      );
    }
  }

  const noRecords = await fetch(`${base}/v6/leaderboardNickname`, {
    method: "POST",
    body: new URLSearchParams({ userToken: `empty-${randomUUID()}`, nickname: "New Driver" }),
  });
  assert.equal(noRecords.status, 200);
  assert.deepEqual(await noRecords.json(), { updatedRecords: 0 });

  const invalid = await fetch(`${base}/v6/leaderboardNickname`, {
    method: "POST",
    body: new URLSearchParams({ userToken, nickname: "   " }),
  });
  assert.equal(invalid.status, 400);
});

test("players can delete only their own leaderboard record for one track", async () => {
  const userToken = `delete-${randomUUID()}`;
  const otherToken = `other-${randomUUID()}`;
  const userId = createHash("sha256").update(userToken).digest("hex");
  const otherId = createHash("sha256").update(otherToken).digest("hex");
  const trackIds = [randomUUID(), randomUUID()].map((value) =>
    createHash("sha256").update(value).digest("hex"),
  );
  const submitRecord = (token, trackId, nickname) => fetch(`${base}/v6/leaderboard`, {
    method: "POST",
    body: new URLSearchParams({
      version: "v6",
      userToken: token,
      nickname,
      carStyle: "default",
      trackId,
      frames: "100",
      recording: `controls-${trackId}-${nickname}`,
    }),
  });

  assert.equal((await submitRecord(userToken, trackIds[0], "Owner")).status, 200);
  assert.equal((await submitRecord(userToken, trackIds[1], "Owner")).status, 200);
  assert.equal((await submitRecord(otherToken, trackIds[0], "Other Driver")).status, 200);

  const deleteRecord = (token, trackId) => fetch(`${base}/v6/leaderboard`, {
    method: "DELETE",
    body: new URLSearchParams({ userToken: token, trackId }),
  });
  const deleted = await deleteRecord(userToken, trackIds[0]);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deletedRecords: 1 });
  const repeated = await deleteRecord(userToken, trackIds[0]);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { deletedRecords: 0 });

  const selectedPage = await fetch(
    `${base}/v6/leaderboard?trackId=${trackIds[0]}&skip=0&amount=20&onlyVerified=false`,
  );
  const selectedEntries = (await selectedPage.json()).entries;
  assert.equal(selectedEntries.some((entry) => entry.userId === userId), false);
  assert.equal(selectedEntries.some((entry) => entry.userId === otherId), true);

  const otherTrackPage = await fetch(
    `${base}/v6/leaderboard?trackId=${trackIds[1]}&skip=0&amount=20&onlyVerified=false`,
  );
  assert.equal(
    (await otherTrackPage.json()).entries.some((entry) => entry.userId === userId),
    true,
    "the same player's record on another track remains",
  );

  assert.equal((await deleteRecord(userToken, "not-a-track-id")).status, 400);
  assert.equal(
    (await fetch(`${base}/v6/leaderboard`, {
      method: "DELETE",
      body: new URLSearchParams({ trackId: trackIds[0] }),
    })).status,
    400,
  );
});

test("0.6.3 Track of the Week returns a bundled track and a UTC Monday expiry", async () => {
  const response = await fetch(`${base}/v6/trackOfTheWeek?version=0.6.3`);
  assert.equal(response.status, 200);

  const result = await response.json();
  assert.ok(Number.isFinite(Date.parse(result.serverTime)));
  assert.ok(result.current);
  assert.match(result.current.trackId, /^[0-9a-f]{64}$/);
  assert.ok([1, 2, 3].includes(result.current.environment));
  assert.equal(result.current.coverUrl, null);
  assert.match(result.current.trackUrl, /^\/main\/tracks\/community\/.+\.track$/);
  assert.match(
    result.current.thumbnailUrl,
    /^\/main\/tracks\/community\/thumbnails\/.+\.png$/,
  );

  const endTime = new Date(result.current.endTime);
  assert.ok(Number.isFinite(endTime.getTime()));
  assert.ok(endTime.getTime() > Date.parse(result.serverTime));
  assert.equal(endTime.getUTCDay(), 1);
  assert.equal(endTime.getUTCHours(), 0);

  const unsupportedVersion = await fetch(
    `${base}/v6/trackOfTheWeek?version=0.6.0-beta2`,
  );
  assert.equal(unsupportedVersion.status, 400);
});

test("automatic track selection changes at Monday 00:00 UTC regardless of timestamp offset", async () => {
  const { getTrackOfTheWeek } = await import("../src/lib/track-of-the-week.ts");
  const mapIdentity = ({ current }) => ({
    trackId: current.trackId,
    name: current.name,
    trackUrl: current.trackUrl,
    thumbnailUrl: current.thumbnailUrl,
  });
  const beforeBoundary = [
    "2026-09-28T00:00:00.000Z",
    "2026-10-04T23:59:59.999Z",
    "2026-10-05T08:59:59.999+09:00",
    "2026-10-04T19:59:59.999-04:00",
  ].map((timestamp) => getTrackOfTheWeek(new Date(timestamp)));
  const atAndAfterBoundary = [
    "2026-10-05T00:00:00.000Z",
    "2026-10-05T09:00:00.000+09:00",
    "2026-10-04T20:00:00.000-04:00",
    "2026-10-11T23:59:59.999Z",
  ].map((timestamp) => getTrackOfTheWeek(new Date(timestamp)));

  for (const result of beforeBoundary.slice(1)) {
    assert.deepEqual(mapIdentity(result), mapIdentity(beforeBoundary[0]));
    assert.equal(result.current.endTime, "2026-10-05T00:00:00.000Z");
  }
  for (const result of atAndAfterBoundary) {
    assert.deepEqual(mapIdentity(result), mapIdentity(atAndAfterBoundary[0]));
    assert.equal(result.current.endTime, "2026-10-12T00:00:00.000Z");
  }
  assert.notDeepEqual(
    mapIdentity(beforeBoundary[1]),
    mapIdentity(atAndAfterBoundary[0]),
  );
});

test("automatic track selection matches bundled catalog metadata across a complete rotation", async () => {
  const [{ getTrackOfTheWeek }, { communityTrackImports }] = await Promise.all([
    import("../src/lib/track-of-the-week.ts"),
    import("@workspace/polytrack-track-catalog"),
  ]);
  const firstMondayUtc = Date.UTC(1970, 0, 5);
  const weekMilliseconds = 7 * 24 * 60 * 60 * 1000;
  const selectedTrackIds = new Set();

  assert.ok(communityTrackImports.length > 0, "The bundled track catalog must not be empty");

  for (const [weekIndex, track] of communityTrackImports.entries()) {
    const { current } = getTrackOfTheWeek(
      new Date(firstMondayUtc + weekIndex * weekMilliseconds),
    );

    assert.deepEqual(
      {
        trackId: current.trackId,
        name: current.name,
        trackUrl: current.trackUrl,
        thumbnailUrl: current.thumbnailUrl,
      },
      {
        trackId: track.id,
        name: track.name,
        trackUrl: `/main/tracks/community/${track.assetFile}`,
        thumbnailUrl: `/main/tracks/community/thumbnails/${track.assetFile.replace(
          /\.track$/,
          ".png",
        )}`,
      },
      `Featured-map metadata must match catalog entry ${weekIndex} (${track.name})`,
    );
    selectedTrackIds.add(current.trackId);
  }

  assert.equal(
    selectedTrackIds.size,
    communityTrackImports.length,
    "A complete rotation must select every bundled catalog entry once",
  );
});
