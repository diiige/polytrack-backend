const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");

const publicDir = path.join(__dirname, "../public");

function loadBundleModules(bundle) {
  const modulesStart = bundle.indexOf("var e,t={") + "var e,t=".length;
  const modulesEnd = bundle.indexOf(",n={};function i(e)", modulesStart);
  assert.ok(modulesStart >= "var e,t=".length, "bundle module table exists");
  assert.ok(modulesEnd > modulesStart, "bundle module table has an end marker");

  const moduleFactories = Function(
    `return (${bundle.slice(modulesStart, modulesEnd)})`,
  )();
  const cache = new Map();
  function requireModule(id) {
    if (id === 1903) return { Buffer };
    if (id === 4394) return crypto;
    if (cache.has(id)) return cache.get(id).exports;

    const module = { exports: {} };
    cache.set(id, module);
    moduleFactories[id](module, module.exports, requireModule);
    return module.exports;
  }

  requireModule.d = (exports, getters) => {
    for (const key in getters) {
      if (
        requireModule.o(getters, key) &&
        !requireModule.o(exports, key)
      ) {
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: getters[key],
        });
      }
    }
  };
  requireModule.o = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);
  requireModule.n = (module) => {
    const getter = module && module.__esModule
      ? () => module.default
      : () => module;
    requireModule.d(getter, { a: getter });
    return getter;
  };
  requireModule.r = (exports) =>
    Object.defineProperty(exports, "__esModule", { value: true });
  requireModule.p = "";
  requireModule.g = globalThis;
  requireModule.amdO = {};
  return requireModule;
}

function readRegistryEntries(bundle, environmentEnum) {
  const entries = [];
  for (const match of bundle.matchAll(
    /trackUrl:"main\/tracks\/community\/([^"]+)"/g,
  )) {
    const entryStart = bundle.lastIndexOf('{id:"', match.index);
    const thumbnailStart = bundle.indexOf("thumbnail:", match.index);
    const entryEnd = bundle.indexOf("}", thumbnailStart);
    assert.ok(entryStart >= 0 && thumbnailStart > match.index && entryEnd > thumbnailStart);
    const entrySource = bundle.slice(entryStart, entryEnd + 1);
    entries.push(
      Function("hl", `return (${entrySource})`)({
        A: environmentEnum,
      }),
    );
  }
  return entries;
}

function parseTrack(code, parsers) {
  for (const parse of parsers) {
    const result = parse(code);
    if (result) return result;
  }
  return null;
}

function findRegisteredTracksUsingPartIds(bundle, requireModule, partIds) {
  const environmentEnum = requireModule(5169).A;
  const parsers = [requireModule(5440).U, requireModule(9681).U];
  const entries = readRegistryEntries(bundle, environmentEnum);

  return entries.flatMap((entry) => {
    const trackPath = path.join(publicDir, entry.trackUrl);
    const code = fs.readFileSync(trackPath, "utf8").trim();
    const imported = parseTrack(code, parsers);
    assert.ok(imported, `${entry.trackMetadata.name} (${entry.id}) loads`);

    const foundPartIds = new Set();
    imported.trackData.forEachPart((_x, _y, _z, type) => {
      if (partIds.includes(type)) foundPartIds.add(type);
    });
    if (foundPartIds.size === 0) return [];

    return [{
      id: entry.id,
      group: entry.group,
      name: entry.trackMetadata.name,
      trackUrl: entry.trackUrl,
      partIds: [...foundPartIds].sort((left, right) => left - right),
    }];
  });
}

module.exports = {
  findRegisteredTracksUsingPartIds,
  loadBundleModules,
  parseTrack,
  readRegistryEntries,
};