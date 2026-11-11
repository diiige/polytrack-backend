import {
  communityTrackImports,
  type CommunityTrackEnvironment,
} from "@workspace/polytrack-track-catalog";

const weekMilliseconds = 7 * 24 * 60 * 60 * 1000;
// Anchor weekly selection to a UTC Monday; local timezone settings must not affect rotation.
const firstMondayUtc = Date.UTC(1970, 0, 5);

const environmentNumbers: Record<CommunityTrackEnvironment, number> = {
  Summer: 1,
  Winter: 2,
  Desert: 3,
};

export function getTrackOfTheWeek(now = new Date()) {
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime)) {
    throw new Error("Track of the Week requires a valid date");
  }

  const weekNumber = Math.floor((currentTime - firstMondayUtc) / weekMilliseconds);
  const trackIndex =
    ((weekNumber % communityTrackImports.length) + communityTrackImports.length) %
    communityTrackImports.length;
  const track = communityTrackImports[trackIndex];
  const endTime = new Date(firstMondayUtc + (weekNumber + 1) * weekMilliseconds);

  return {
    serverTime: now.toISOString(),
    current: {
      trackId: track.id,
      name: track.name,
      author: track.author,
      lastModified: track.lastModified,
      environment: environmentNumbers[track.environment],
      thumbnailUrl:
        `/main/tracks/community/thumbnails/${track.assetFile.replace(/\.track$/, ".png")}`,
      coverUrl: null,
      trackUrl: `/main/tracks/community/${track.assetFile}`,
      endTime: endTime.toISOString(),
    },
  };
}