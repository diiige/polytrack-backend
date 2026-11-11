const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

test("native PB bridge supplies live identity and drains only the target map's writes", async () => {
  const { installPolytrackPbBridge } = await import("../main-bundle-startup-patch.js");
  const browserWindow = {};
  let token = "native-profile-token";
  const profiles = {
    profileSlot: 1,
    getCurrentUserProfile: () => ({
      token, nickname: "Native player", countryCode: null,
      carStyle: { serialize: () => "default" },
    }),
  };
  let finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const records = { syncRecord: () => deferred, setRecord: () => new Promise(() => {}) };
  installPolytrackPbBridge(browserWindow, profiles, records, "polytrack_v5_beta_");
  assert.equal(browserWindow.__polytrackGetActiveProfile().key, "polytrack_v5_beta_user_1");
  assert.equal(browserWindow.__polytrackGetActiveProfile().profile.token, token);
  token = "switched-native-profile";
  assert.equal(browserWindow.__polytrackGetActiveProfile().profile.token, token);
  records.syncRecord(1, "target");
  records.setRecord(1, "other-map");
  records.setRecord(0, "target");
  let settled = false;
  const wait = browserWindow.__polytrackWaitForRecordWrites("target").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "deletion cannot overtake a native upload/download");
  finish();
  await wait;
  assert.equal(settled, true, "unrelated map/profile writes do not block deletion");
});

test("native PB refresh reads current storage after deletion rather than restoring the open-time PB", async () => {
  const { patchPolytrackMainBundle } = await import("../main-bundle-startup-patch.js");
  const source = fs.readFileSync(new URL("../public/main.bundle.js", `file://${__filename}`), "utf8");
  const patched = patchPolytrackMainBundle(source);
  const start = patched.indexOf("((e,t)=>{const v=r.getRecord(i.profileSlot,h);");
  assert.ok(start >= 0);
  const callbackEnd = "total:t})})";
  const callback = patched.slice(start + 1, patched.indexOf(callbackEnd, start) + callbackEnd.length - 1);
  const renders = [];
  const time = (frames) => ({ frames, lessOrEqual(other) { return frames <= other.frames; } });
  let saved = { time: time(120) };
  const render = vm.runInNewContext(callback, {
    r: { getRecord(slot, track) { assert.equal(slot, 0); assert.equal(track, "test-track"); return saved; } },
    i: { profileSlot: 0 }, h: "test-track",
    R: { gn: () => (value, rank) => renders.push({ value, rank }) },
    Vo: {}, ol: {},
  });
  render(null, 0);
  assert.equal(renders.at(-1).value.frames, 120);
  saved = null;
  render(null, 0);
  assert.equal(renders.at(-1).value, null, "deleted PB stays absent on subsequent native refresh");
  saved = { time: time(90) };
  render(null, 0);
  assert.equal(renders.at(-1).value.frames, 90, "a newer local PB remains visible");
  render({ time: time(80), position: 1 }, 2);
  assert.equal(renders.at(-1).value.frames, 80, "a newer server PB still renders");
  assert.ok(patched.includes(".__polytrackRefreshLeaderboard=()=>"));
  assert.ok(patched.includes(".__polytrackResetLeaderboardPage=()=>"));
  assert.ok(patched.includes('window.__polytrackStartReplayWatch?.((0,R.gn)(this,kf,"f").map((e=>e.settings.recording)))'));
  assert.ok(patched.includes("dispose(){window.__polytrackEndReplayWatch?.();"));
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("startup completion callback is deferred until its lexical dependencies initialize", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);

  assert.notEqual(patched, source);
  const shardmirEntry =
    'id:"b8e8e83ddce68a174ca6a544c658a29c613f09c126bc83a8800383961033f36f",group:"0.5.2",trackMetadata:{name:"ShardMir",author:"Jurre",lastModified:null},environment:hl.A.Desert,trackUrl:"main/tracks/community/shardmir.track",thumbnail:"main/tracks/community/thumbnails/shardmir.png"';
  assert.equal(patched.split(shardmirEntry).length - 1, 1);
  assert.ok(
    fs.existsSync(
      new URL(
        "../public/main/tracks/community/thumbnails/shardmir.png",
        `file://${__filename}`,
      ),
    ),
  );
  assert.ok(
    patched.indexOf(shardmirEntry) <
      patched.indexOf('id:"6f341a64070d52a00435604bfe79ee1f6d736c83511c426a1637e21d32e48c15"'),
    "ShardMir appears in the latest community-map group",
  );
  const shardmirTrack = fs.readFileSync(
    new URL("../public/main/tracks/community/shardmir.track", `file://${__filename}`),
    "utf8",
  );
  assert.ok(shardmirTrack.startsWith("PolyTrack14"));
  assert.equal(Buffer.byteLength(shardmirTrack), 94259);
  assert.ok(
    patched.includes(
      "window.__polytrackStartupReady=!1,t.addCompleteListener((()=>{queueMicrotask(()=>{if(!window.__polytrackStartupReady)return;if(E.cleanUpRecords()",
    ),
  );
  assert.ok(
    patched.includes(
      "const E=new rd(e,w,S,x);(function installPolytrackPbBridge",
    ),
  );
  assert.ok(patched.includes('window.__polytrackStartupReady=!0;const T=new ne'));
  assert.ok(patched.includes("q(e)}}});}));const a=i(7780);"));
  assert.ok(patched.includes("for(const r of t.carStateBuffers)"),
    "each car callback visits every state in the worker batch");
  assert.ok(patched.includes("Math.max(c.frames,e+1)"),
    "each car callback preserves advancing frames and repairs repeats");
  assert.ok(patched.includes(
    "Math.min(window.devicePixelRatio||1,1.5):1",
  ), "high-DPI rendering is capped without overriding render-scale settings");
  assert.ok(
    patched.includes(
      "if(s.replayBoostSettings)d.replayBoostSettings=s.replayBoostSettings",
    ),
    "saved replay settings remain attached to the decoded recording",
  );
  assert.ok(patched.includes("if(s.normalPhysicsConfirmed===true)d.normalPhysicsConfirmed=true"));
  assert.ok(patched.includes("if(s.replayBoostTimeline)d.replayBoostTimeline=s.replayBoostTimeline"));
  assert.ok(
    patched.includes(
      "carRecording:s?.serialize()??null,replayBoostSettings:s?.replayBoostSettings??null",
    ),
    "the replay worker receives the settings saved with the recording",
  );
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("TURN credential patch preserves authentication fields for the browser", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);
  const patchStart = patched.indexOf("const iceServer={urls:n};");
  const patchEnd =
    patched.indexOf("r.push(iceServer)", patchStart) + "r.push(iceServer)".length;
  assert.ok(patchStart >= 0 && patchEnd > patchStart);

  const createIceServer = new Function(
    "e",
    "n",
    "t",
    patched
      .slice(patchStart, patchEnd)
      .replace("r.push(iceServer)", "return iceServer"),
  );
  assert.deepEqual(
    createIceServer(
      {
        username: "relay-user",
        credential: "relay-password",
        credentialType: "password",
      },
      ["turn:relay.example.test:443"],
      (error) => {
        throw error;
      },
    ),
    {
      urls: ["turn:relay.example.test:443"],
      username: "relay-user",
      credential: "relay-password",
      credentialType: "password",
    },
  );
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("host multiplayer forwards its first and subsequent ICE candidates", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);
  const candidateHandler =
    'c.onicecandidate=t=>{null!=t.candidate&&o.send(JSON.stringify({version:Pt.rE,type:"iceCandidate",session:e,candidate:t.candidate}))}';
  assert.equal(patched.split(candidateHandler).length - 1, 1);

  const sent = [];
  const connection = {};
  new Function("c", "o", "e", "Pt", candidateHandler)(
    connection,
    { send: (message) => sent.push(JSON.parse(message)) },
    "test-session",
    { rE: "test-version" },
  );
  const candidates = [
    { candidate: "first-host-candidate" },
    { candidate: "second-host-candidate" },
  ];
  for (const candidate of candidates) {
    connection.onicecandidate({ candidate });
  }
  assert.deepEqual(
    sent.map((message) => message.candidate),
    candidates,
    "the first ICE candidate is forwarded instead of being dropped",
  );
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("host ICE candidate patch fails loudly if its upstream handler changes", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const renamedHandler = source.replace(
    'c.onicecandidate=t=>{null!=t.candidate&&(c.onicecandidate=t=>{o.send(JSON.stringify({version:Pt.rE,type:"iceCandidate",session:e,candidate:t.candidate}))})}',
    "c.renamedIceCandidateHandler",
  );
  assert.throws(
    () => patchPolytrackMainBundle(renamedHandler),
    /PolyTrack host ICE candidate patch target was not found uniquely/,
  );
});

test("TURN credential patch fails loudly if the upstream parser changes", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const renamedAnchor = source.replace(
    "r.push({urls:n})",
    "r.push({urls:n,username:e.username})",
  );
  assert.throws(
    () => patchPolytrackMainBundle(renamedAnchor),
    /PolyTrack ICE credentials patch target was not found uniquely/,
  );
});

test("startup patch fails loudly if the upstream bundle changes", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  assert.throws(
    () => patchPolytrackMainBundle("const main = true;"),
    /patch target was not found uniquely/,
  );
});

test("PolyTrack no longer blocks startup when another browser page is open", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);

  assert.ok(!patched.includes("polytrack-single-instance"));
  assert.ok(
    !patched.includes(
      'u.showNoButtons(e.get("You already have another instance of PolyTrack open.")',
    ),
    "the blocking dialog is removed; the unused translation string may remain",
  );
  assert.ok(
    patched.includes("c.determinismState==oo.Ok?i()"),
    "the normal determinism check still runs without the single-instance gate",
  );
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("multi-instance patch fails loudly if its upstream guard changes", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const renamedGuard = source.replace(
    "polytrack-single-instance",
    "renamed-single-instance",
  );

  assert.throws(
    () => patchPolytrackMainBundle(renamedGuard),
    /PolyTrack multi-instance restriction patch target was not found uniquely/,
  );
});

test("community track patch fails loudly if its registry anchor changes", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const registryWithoutAnchor = source.replace(
    '{id:"6f341a64070d52a00435604bfe79ee1f6d736c83511c426a1637e21d32e48c15"',
    '{id:"removed"',
  );
  assert.throws(
    () => patchPolytrackMainBundle(registryWithoutAnchor),
    /Community track registry patch target was not found uniquely/,
  );
});

test("newest community revisions hide older same-title entries", async () => {
  const { patchPolytrackMainBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);

  assert.doesNotMatch(
    patched,
    /},,\{id:"/,
    "removing older rows preserves the registry's comma-separated entries",
  );
  assert.ok(
    !patched.includes(
      'id:"984bb1361ed45e000120aa0199f6f1ef21d5f6482f76c948df369758ac47f7e8"',
    ),
    "the older Flying Dreams entry is hidden",
  );
  assert.ok(
    patched.includes(
      'id:"35fe02bf18312713c05528f0b7b8fd15c83dac50bcdcbd373040a16e8bfcc138"',
    ),
    "the newest Flying Dreams entry remains",
  );
  assert.equal(
    patched.split(
      'trackMetadata:{name:"Flying Dreams",author:"Forty, Shovelfish, Hero",',
    ).length - 1,
    1,
  );

  assert.ok(
    !patched.includes(
      'id:"00d39d287da724b1c6b69eab85379f44ee4ae2fc0876343666b944cf4c3156e5"',
    ),
    "the older Re : Akina entry is hidden",
  );
  assert.ok(
    patched.includes(
      'id:"af6ef508e1f6e47a462a6998b950ef535d1e8a38fe67ead891bf5f2de1346f43"',
    ),
    "the newest Re : Akina entry remains",
  );
  assert.equal(
    patched.split('trackMetadata:{name:"Re : Akina",author:"Marcus",').length - 1,
    1,
  );
});

test("archive and 0.6.3 community maps and track parts are registered", async () => {
  const [{ patchPolytrackMainBundle }, { communityTrackImports }] =
    await Promise.all([
      import("../main-bundle-startup-patch.js"),
      import("../community-track-imports.js"),
    ]);
  const source = fs.readFileSync(
    new URL("../public/main.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackMainBundle(source);

  assert.equal(communityTrackImports.length, 42);
  assert.equal(
    communityTrackImports.filter(({ group }) => group === "0.6.3").length,
    10,
    "all ten official 0.6.3 community tracks are included",
  );
  const firstReleaseTrack = communityTrackImports.find(
    ({ group }) => group === "0.6.3",
  );
  const firstOlderTrack = communityTrackImports.find(
    ({ group }) => group !== "0.6.3",
  );
  assert.ok(
    patched.indexOf(`id:${JSON.stringify(firstReleaseTrack.id)}`) <
      patched.indexOf(`id:${JSON.stringify(firstOlderTrack.id)}`),
    "the 0.6.3 release group is registered before older community groups",
  );
  assert.equal(
    new Set(communityTrackImports.map(({ id }) => id)).size,
    communityTrackImports.length,
    "archive registry IDs are unique",
  );
  assert.ok(patched.includes("BlockOuterCorner=188"));
  assert.ok(patched.includes("PlaneCorner=189"));
  assert.ok(
    patched.includes(
      'new d("5e3b086f679fc9ff779abba9a7ea0db59a0a4dbd0540cd4aa501e2bfea1673f5",r.A.Block,s.A.BlockOuterCorner',
    ),
  );
  assert.ok(
    patched.includes(
      'new d("f6809dcb8440d3c6043bfd91eb84add7facf61565ce4fd6c2aa73a5a9da32934",r.A.Plane,s.A.PlaneCorner',
    ),
  );
  assert.ok(
    patched.includes(
      'id:"a6b990137e404c9ef2cb4399c463acbed8ebfa3bb82ab5315027118604c4ec03",group:"0.5.2",trackMetadata:{name:"Starry Tropisx",author:"Leaf, Forty, WB"',
    ),
    "the registered metadata matches the imported Starry Tropisx track",
  );

  for (const entry of communityTrackImports) {
    const entryPrefix =
      `{id:${JSON.stringify(entry.id)},group:${JSON.stringify(entry.group)},trackMetadata:{name:${JSON.stringify(entry.name)},author:${JSON.stringify(entry.author)},lastModified:`;
    assert.ok(patched.includes(entryPrefix), `${entry.name} is in the registry`);
    assert.ok(
      fs.existsSync(
        new URL(
          `../public/main/tracks/community/${entry.assetFile}`,
          `file://${__filename}`,
        ),
      ),
      `${entry.name} track file exists`,
    );
    assert.ok(
      fs.existsSync(
        new URL(
          `../public/main/tracks/community/thumbnails/${entry.assetFile.replace(/\.track$/, ".png")}`,
          `file://${__filename}`,
        ),
      ),
      `${entry.name} thumbnail exists`,
    );
  }
});

test("Garage profile name saves notify the leaderboard updater", async () => {
  const { patchPolytrackProfileSettingsBundle } = await import(
    "../main-bundle-startup-patch.js"
  );
  const source = fs.readFileSync(
    new URL("../public/280.bundle.js", `file://${__filename}`),
    "utf8",
  );
  const patched = patchPolytrackProfileSettingsBundle(source);

  assert.ok(
    patched.includes("window.__polytrackProfileNicknameSaved?."),
    "the native profile confirmation reports nickname changes",
  );
  assert.ok(
    patched.includes('.maxLength=32'),
    "the Garage field matches the leaderboard endpoint's name limit",
  );
  assert.ok(
    patched.includes('for(;t.length>32;)t=Array.from(t).slice(0,-1).join("")'),
    "input truncation keeps the limit safe for Unicode names",
  );
  assert.doesNotThrow(() => new vm.Script(patched));
});