const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const { test } = require("node:test");
const {
  loadBundleModules,
  parseTrack,
  readRegistryEntries,
} = require("./community-track-test-utils.cjs");

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.crypto = crypto.webcrypto;
globalThis.Buffer = Buffer;

function readGlbJson(filePath) {
  const glb = fs.readFileSync(filePath);
  assert.equal(glb.toString("ascii", 0, 4), "glTF");
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
}

test("community registry tracks load and round-trip through saves and exports", async () => {
  const [{ patchPolytrackMainBundle }, { communityTrackImports }] =
    await Promise.all([
      import("../main-bundle-startup-patch.js"),
      import("../community-track-imports.js"),
    ]);
  const rawBundle = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const bundle = patchPolytrackMainBundle(rawBundle);
  const requireModule = loadBundleModules(bundle);
  const environmentEnum = requireModule(5169).A;
  const trackDataApi = requireModule(8438).A;
  const parsers = [requireModule(5440).U, requireModule(9681).U];
  const registryEntries = readRegistryEntries(bundle, environmentEnum);
  const tracksUsing061Parts = [];

  assert.equal(registryEntries.length, 72);
  for (const entry of communityTrackImports) {
    const registered = registryEntries.filter(({ id }) => id === entry.id);
    assert.equal(registered.length, 1, `${entry.name} has one registry entry`);
    assert.equal(
      registered[0].trackUrl,
      `main/tracks/community/${entry.assetFile}`,
    );
    assert.equal(registered[0].trackMetadata.name, entry.name);
    assert.equal(registered[0].trackMetadata.author, entry.author);
  }

  for (const entry of registryEntries) {
    const label = `${entry.trackMetadata.name} (${entry.id})`;
    const trackPath = new URL(`../public/${entry.trackUrl}`, `file://${__filename}`);
    const thumbnailPath = new URL(
      `../public/${entry.thumbnail}`,
      `file://${__filename}`,
    );
    assert.ok(fs.existsSync(trackPath), `${label} track file exists`);
    assert.ok(fs.existsSync(thumbnailPath), `${label} thumbnail exists`);
    assert.equal(
      fs.readFileSync(thumbnailPath).readUInt32BE(0),
      0x89504e47,
      `${label} thumbnail is a PNG`,
    );

    const imported = parseTrack(
      fs.readFileSync(trackPath, "utf8").trim(),
      parsers,
    );
    assert.ok(imported, `${label} loads`);
    assert.equal(imported.trackData.getId(), entry.id, `${label} canonical ID`);
    assert.equal(
      imported.trackMetadata.name,
      entry.trackMetadata.name,
      `${label} display name`,
    );
    assert.equal(
      imported.trackMetadata.author,
      entry.trackMetadata.author,
      `${label} author`,
    );
    assert.ok(imported.trackData.hasStartingPoint(), `${label} has a start`);
    const partTypes = new Set();
    imported.trackData.forEachPart((_x, _y, _z, type) => partTypes.add(type));
    const newPartIds = [188, 189].filter((type) => partTypes.has(type));
    if (newPartIds.length > 0) {
      tracksUsing061Parts.push({
        group: entry.group,
        name: entry.trackMetadata.name,
        partIds: newPartIds,
      });
    }
    if (entry.name === "The Eldritch Estate") {
      assert.ok(
        partTypes.has(188),
        `${label} includes the 0.6.1 BlockOuterCorner used by the worker regression`,
      );
    }

    const saved = trackDataApi.fromSaveString(
      imported.trackData.toSaveString(),
    );
    assert.equal(saved?.getId?.(), entry.id, `${label} local-save round trip`);

    const exported = trackDataApi.fromExportString(
      imported.trackData.toExportString(imported.trackMetadata),
    );
    assert.equal(
      exported?.trackData?.getId?.(),
      entry.id,
      `${label} import/export round trip`,
    );
    assert.equal(
      exported?.trackMetadata?.name,
      entry.trackMetadata.name,
      `${label} exported name`,
    );
    assert.equal(
      exported?.trackMetadata?.author,
      entry.trackMetadata.author,
      `${label} exported author`,
    );
  }

  assert.deepEqual(
    Object.fromEntries(
      tracksUsing061Parts.map(({ name, partIds }) => [name, partIds]),
    ),
    {
      "𐌀𐌕𐌋𐌀𐌍𐌕𐌉𐌔": [188],
      Apostle: [188, 189],
      "݁˖.˚ Evanescent Bliss. ݁₊˚ .": [188],
      "La Infinita": [188, 189],
      Natsu: [188],
      "Out of Bounds": [188, 189],
      Overclocked: [189],
      Oyasumi: [188],
      "Rolling Hills Racer": [189],
      Solaris: [188, 189],
      Stardust: [188],
      "The Eldritch Estate": [188],
      "The CrossFades": [188, 189],
      "Tucks Factory": [188, 189],
      "𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢": [188],
      Zenith: [188, 189],
      "sandy lanes II": [188, 189],
    },
    "the registered tracks using each 0.6.1 part ID are identified",
  );
  assert.ok(
    tracksUsing061Parts.every(({ group, name }) =>
      [
        "𐌀𐌕𐌋𐌀𐌍𐌕𐌉𐌔",
        "݁˖.˚ Evanescent Bliss. ݁₊˚ .",
        "La Infinita",
        "Out of Bounds",
        "Oyasumi",
        "Solaris",
        "The CrossFades",
        "Tucks Factory",
        "𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢",
        "Zenith",
      ].includes(name)
        ? group === "0.6.3"
        : group === "0.6.1",
    ),
    "tracks using IDs 188 or 189 retain the correct 0.6.1 or 0.6.3 group",
  );

  const blocks = readGlbJson(
    new URL("../public/models/blocks.glb", `file://${__filename}`),
  );
  const planes = readGlbJson(
    new URL("../public/models/planes.glb", `file://${__filename}`),
  );
  assert.ok(blocks.nodes.some(({ name }) => name === "BlockOuterCorner"));
  assert.ok(planes.nodes.some(({ name }) => name === "PlaneCorner"));
});