const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const { test } = require("node:test");
const {
  loadBundleModules,
  parseTrack,
} = require("./community-track-test-utils.cjs");

const repositoryRoot = path.resolve(__dirname, "../../..");
const publicDirectory = path.join(repositoryRoot, "artifacts/polytrack/public");
const communityAssetsDirectory = path.join(
  publicDirectory,
  "main/tracks/community",
);

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.crypto = crypto.webcrypto;
globalThis.Buffer = Buffer;

test("community catalog entries identify their bundled track assets", async () => {
  const [{ communityTrackImports }, { patchPolytrackMainBundle }] =
    await Promise.all([
      import("../../../lib/polytrack-track-catalog/src/index.ts"),
      import("../main-bundle-startup-patch.js"),
    ]);
  const rawBundle = fs.readFileSync(
    path.join(publicDirectory, "main.bundle.js"),
    "utf8",
  );
  const bundle = patchPolytrackMainBundle(rawBundle);
  const requireModule = loadBundleModules(bundle);
  const parsers = [requireModule(5440).U, requireModule(9681).U];

  assert.ok(
    communityTrackImports.length > 0,
    "the community catalog is populated",
  );

  for (const entry of communityTrackImports) {
    const relativeAssetPath = path.posix.join(
      "main/tracks/community",
      entry.assetFile,
    );
    const trackPath = path.join(communityAssetsDirectory, entry.assetFile);
    const label = `catalog entry "${entry.name}" (${entry.id}) at ${relativeAssetPath}`;
    const trackCode = fs.readFileSync(trackPath, "utf8").trim();
    const imported = parseTrack(trackCode, parsers);

    assert.ok(imported, `${label} could not be decoded`);
    assert.equal(
      imported.trackData.getId(),
      entry.id,
      `${label} has the wrong canonical track ID`,
    );
    assert.equal(
      imported.trackMetadata.name,
      entry.name,
      `${label} has the wrong display name`,
    );
    assert.equal(
      imported.trackMetadata.author,
      entry.author,
      `${label} has the wrong display author`,
    );
  }
});
