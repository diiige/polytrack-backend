const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");
const communityAssetsDirectory = path.join(
  repositoryRoot,
  "artifacts/polytrack/public/main/tracks/community",
);

test("every community track catalog entry has bundled track and thumbnail assets", async () => {
  const { communityTrackImports } =
    await import("../../../lib/polytrack-track-catalog/src/index.ts");

  assert.ok(
    communityTrackImports.length > 0,
    "the community catalog is populated",
  );

  for (const entry of communityTrackImports) {
    const label = `${entry.name} (${entry.id})`;
    const trackPath = path.join(communityAssetsDirectory, entry.assetFile);
    const thumbnailPath = path.join(
      communityAssetsDirectory,
      "thumbnails",
      entry.assetFile.replace(/\.track$/, ".png"),
    );

    assert.ok(
      fs.existsSync(trackPath),
      `${label} is missing bundled track asset: ${path.relative(repositoryRoot, trackPath)}`,
    );
    assert.ok(
      fs.existsSync(thumbnailPath),
      `${label} is missing bundled thumbnail: ${path.relative(repositoryRoot, thumbnailPath)}`,
    );
  }
});
