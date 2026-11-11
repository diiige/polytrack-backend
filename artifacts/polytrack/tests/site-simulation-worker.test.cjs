const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const publicDir = path.join(__dirname, "../public");
const wrapper = readFileSync(path.join(publicDir, "site-simulation-worker.js"), "utf8");
const nativeBundle = readFileSync(path.join(publicDir, "simulation_worker.bundle.js"), "utf8");

const updateCall =
  'function a(e,i){t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,i.up,i.right,i.down,i.left,i.reset,n]);return';
const nativeUpdateFunction =
  `${updateCall} new Uint8Array(t.HEAPU8.buffer,n,s).slice().buffer}`;
const carState =
  "e.push({id:l,controls:s,userControls:n,hasStarted:!1,frames:0,targetSimulationFrames:null,isPaused:!1})";
const controlStart =
  'if(s.id==r){if(null==s.userControls)throw new Error("Tried to control uncontrollable car")';
const realtimeControls =
  "controls:{up:t.userControls.up,right:t.userControls.right,down:t.userControls.down,left:t.userControls.left,reset:t.userControls.reset}";
const bootHandler = "onmessage=t=>{il.push(t)}";
const readyHandler = "il.length=0,onmessage=i";

test("worker patch targets still match the compiled physics bundle", () => {
  for (const target of [
    nativeUpdateFunction, carState, controlStart, realtimeControls, bootHandler, readyHandler,
  ]) {
    assert.equal(nativeBundle.split(target).length, 2, "worker target must appear exactly once");
  }
  const updatePatch = wrapper.match(/const updateCar = '([^']+)';\s+const boostedUpdateCar = '([^']+)';/);
  assert.ok(updatePatch, "worker update replacement must be present");
  assert.doesNotThrow(
    () => new vm.Script(nativeBundle.replace(updatePatch[1], updatePatch[2])),
    "the patched compiled worker must remain valid JavaScript",
  );
});

test("worker startup patch registers the PolyTrack 0.6.1 track parts", async () => {
  let patchedSource;
  const self = {
    onmessage: null,
    postMessage() {},
  };
  const context = {
    self,
    fetch: async () => ({ text: async () => nativeBundle }),
    DataView,
    Map,
    Set,
    Array,
    Number,
    eval(source) {
      patchedSource = source;
    },
  };
  Object.defineProperty(context, "onmessage", {
    get() { return self.onmessage; },
    set(handler) { self.onmessage = handler; },
  });
  vm.runInNewContext(wrapper, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(patchedSource, "the wrapper evaluates a patched physics bundle");
  assert.ok(patchedSource.includes('t[t.BlockOuterCorner=188]="BlockOuterCorner"'));
  assert.ok(patchedSource.includes('t[t.PlaneCorner=189]="PlaneCorner"'));
  assert.ok(patchedSource.includes('Xa.Block,Za.BlockOuterCorner'));
  assert.ok(patchedSource.includes('Xa.Plane,Za.PlaneCorner'));
  assert.doesNotThrow(
    () => new vm.Script(patchedSource),
    "the patched physics bundle remains valid JavaScript",
  );
});

test("player physics boosts move only the player and preserve logical race frames", async () => {
  const nativeMessages = [];
  const childWorkers = [];
  class ChildWorker {
    constructor(url) {
      this.url = url;
      this.messages = [];
      childWorkers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const self = {
    onmessage: null,
    postMessage(message) { nativeMessages.push(message); },
  };
  const fixture = `
    const t = {
      calls: [],
      HEAPU8: new Uint8Array(228),
      physicsFrames: new Map(),
      motion: new Map(),
      ccall(_name, _result, _types, values) {
        const id = values[0];
        this.calls.push(id);
        const frame = (this.physicsFrames.get(id) || 0) + 1;
        this.physicsFrames.set(id, frame);
        const motion = this.motion.get(id) || {
          speed: 0, distance: 0, accelerationUpdates: 0, brakingUpdates: 0,
        };
        if (values[1]) {
          motion.speed += 2;
          motion.accelerationUpdates += 1;
        } else if (values[3]) {
          motion.speed = Math.max(0, motion.speed - 3);
          motion.brakingUpdates += 1;
        }
        motion.distance += motion.speed / 60;
        this.motion.set(id, motion);
        const view = new DataView(this.HEAPU8.buffer);
        const offset = 1;
        view.setUint32(offset, id, true);
        view.setUint8(offset + 4, frame & 255);
        view.setUint8(offset + 5, (frame >>> 8) & 255);
        view.setUint8(offset + 6, (frame >>> 16) & 255);
        view.setFloat32(offset + 7, motion.speed, true);
        const hasFinished = id === 7 && frame >= 6;
        view.setUint8(offset + 11, hasFinished ? 2 : 0);
        if (hasFinished) {
          view.setUint8(offset + 12, 6 & 255);
          view.setUint8(offset + 13, (6 >>> 8) & 255);
          view.setUint8(offset + 14, (6 >>> 16) & 255);
        }
      },
    };
    t[t.PlaneWallSlopeDownLongRight=187]="PlaneWallSlopeDownLongRight";
    const Xa = { Plane: 0, Block: 1 };
    const Za = { PlaneSlopeUp: 1, BlockSlopeVerticalCornerBottom: 2 };
    const ao = [], oo = [];
    function lo() {}
    const workerTrackPartRegistry = [
      new lo("2dda4d3801c9cd4c117dc3c8239bea28cafe70ef2127986c2d6b455744fc8019",Xa.Plane,Za.PlaneSlopeUp,[["Planes","PlaneSlopeUp"]],ao,[[[-2,0,-2],[1,0,1]],[[-2,1,-2],[1,1,-2]]]),
      new lo("cc9c95eef56def4cf013e4ac85b8013a2b4f4b4346f1f5dd41fa017de763ef17",Xa.Block,Za.BlockSlopeVerticalCornerBottom,[["Blocks","BlockSlopeVerticalCornerBottom"]],oo,[[[-2,0,-2],[1,0,1]],[[-2,1,-2],[0,1,0]],[[1,1,-2],[1,1,-1]],[[-2,1,1],[-1,1,1]],[[-2,2,-2],[-1,2,-1]],[[-2,2,0],[-1,2,0]],[[0,2,-2],[0,2,-1]],[[1,2,-2],[1,2,-2]],[[-2,2,1],[-2,2,1]],[[-2,3,-2],[-1,3,-1]],[[-2,3,0],[-2,3,1]],[[0,3,-2],[1,3,-2]]]),
    ];
    const n = 1, s = 227, e = [];
    ${nativeUpdateFunction}
    function addCar(l,s,n,replayBoostSettings,replayBoostTimeline) {
      const t = { replayBoostSettings, replayBoostTimeline };
      ${carState};
      return e[e.length - 1];
    }
    function handleControls(t) {
      const r = t.carId;
      for (const s of e) {
        ${controlStart};
          s.userControls.up = t.up;
          s.userControls.right = t.right;
          s.userControls.down = t.down;
          s.userControls.left = t.left;
          s.userControls.reset = t.reset;
        }
      }
    }
    function realtime(t) { return { ${realtimeControls} }; }
    const handled = [];
    self.__test = { t, a, addCar, realtime, handled };
    const il = [];
    ${bootHandler};
    Promise.resolve().then(() => {
      function i(event) {
        handled.push(event.data);
        if (event.data.messageType === 6) handleControls(event.data);
      }
      for (const event of il) i(event);
      ${readyHandler};
    });
  `;
  const context = {
    self,
    fetch: async () => ({ text: async () => fixture }),
    DataView,
    Set,
    Array,
    Worker: ChildWorker,
  };
  Object.defineProperty(context, "onmessage", {
    get() { return self.onmessage; },
    set(handler) { self.onmessage = handler; },
  });
  vm.runInNewContext(wrapper, context);
  const routingHandler = self.onmessage;
  self.onmessage({ data: { messageType: 0, isRealtime: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(self.onmessage, routingHandler, "async WASM setup cannot replace our routing hook");

  const controls = { up: true, right: false, down: false, left: false, reset: false };
  const boosted = self.__test.addCar(7, {}, { ...controls });
  const ghost = self.__test.addCar(8, {}, null);
  assert.equal(self.__test.handled[0].messageType, 0, "early init reaches native worker");
  self.onmessage({ data: { messageType: 3, carId: 7, carRecording: null } });
  self.onmessage({ data: { messageType: 3, carId: 8, carRecording: "ghost-controls" } });
  self.onmessage({ data: { messageType: 5, carId: 8 } });
  self.onmessage({
    data: {
      messageType: 6, carId: 7, up: true, accelerationBoost: true,
      accelerationMultiplier: 1.5, brakingMultiplier: 1, topSpeedMultiplier: 1.2,
    },
  });
  assert.equal(childWorkers.length, 1);
  assert.equal(childWorkers[0].url, "site-simulation-worker.js");
  assert.deepEqual(childWorkers[0].messages.map((message) => message.messageType), [0, 3, 5]);
  assert.equal(childWorkers[0].messages[1].__polytrackReplayWorker, true);
  assert.equal(childWorkers[0].messages[1].replayBoostSettings, undefined);
  assert.equal(self.__test.handled.some((message) => message.carId === 8), false);

  const ordinaryReplaySelf = {
    onmessage: null,
    postMessage() {},
  };
  const ordinaryReplayContext = {
    self: ordinaryReplaySelf,
    fetch: async () => ({ text: async () => fixture }),
    DataView, Set, Array, Worker: ChildWorker,
  };
  Object.defineProperty(ordinaryReplayContext, "onmessage", {
    get() { return ordinaryReplaySelf.onmessage; },
    set(handler) { ordinaryReplaySelf.onmessage = handler; },
  });
  vm.runInNewContext(wrapper, ordinaryReplayContext);
  ordinaryReplaySelf.onmessage({ data: childWorkers[0].messages[0] });
  await new Promise((resolve) => setImmediate(resolve));
  ordinaryReplaySelf.onmessage({ data: childWorkers[0].messages[1] });
  const ordinaryReplay = ordinaryReplaySelf.__test.addCar(8, {}, null);
  assert.equal(ordinaryReplaySelf.__test.handled.at(-1).carId, 8,
    "an unmarked replay reaches the patched native simulation");
  assert.equal(ordinaryReplay.boost, false,
    "an unmarked replay keeps normal physics in the patched worker");
  ordinaryReplaySelf.onmessage({ data: childWorkers[0].messages[2] });
  assert.equal(ordinaryReplaySelf.__test.handled.at(-1).messageType, 5);

  self.onmessage({
    data: {
      messageType: 3, carId: 12, carRecording: "boosted-controls",
      replayBoostSettings: {
        accelerationMultiplier: 1.5, brakingMultiplier: 1,
        topSpeedMultiplier: 1.2,
      },
    },
  });
  assert.equal(childWorkers.length, 2);
  assert.equal(childWorkers[1].url, "site-simulation-worker.js",
    "boosted recordings use a patched, isolated physics worker");
  assert.deepEqual(childWorkers[1].messages.map((message) => message.messageType), [0, 3]);
  assert.equal(childWorkers[1].messages[1].__polytrackReplayWorker, true);
  self.onmessage({ data: { messageType: 5, carId: 12 } });
  assert.equal(childWorkers[1].messages.at(-1).messageType, 5);

  const replayMessages = [];
  const replaySelf = {
    onmessage: null,
    postMessage(message) { replayMessages.push(message); },
  };
  const replayContext = {
    self: replaySelf,
    fetch: async () => ({ text: async () => fixture }),
    DataView, Set, Array, Worker: ChildWorker,
  };
  Object.defineProperty(replayContext, "onmessage", {
    get() { return replaySelf.onmessage; },
    set(handler) { replaySelf.onmessage = handler; },
  });
  vm.runInNewContext(wrapper, replayContext);
  replaySelf.onmessage({ data: childWorkers[1].messages[0] });
  await new Promise((resolve) => setImmediate(resolve));
  replaySelf.onmessage({ data: childWorkers[1].messages[1] });
  assert.equal(childWorkers.length, 2, "boosted replay must not create another ghost worker");
  assert.equal(replaySelf.__test.handled.at(-1).carId, 12,
    "recorded controls reach the patched native simulation");
  const replay = replaySelf.__test.addCar(
    12, {}, null, childWorkers[1].messages[1].replayBoostSettings,
  );
  assert.equal(replay.userControls, null);
  assert.equal(replay.boost, true);
  const replayStates = [];
  for (let tick = 0; tick < 2; tick += 1) {
    replayStates.push(replaySelf.__test.a(replay, {
      up: true, right: false, down: false, left: false, reset: false,
    }));
    replay.frames += 1;
  }
  assert.equal(replaySelf.__test.t.calls.filter((id) => id === 12).length, 3,
    "two recorded inputs reproduce three accelerated physics updates");
  const replayFrame = (state) => {
    const view = new DataView(state);
    return view.getUint8(4) | view.getUint8(5) << 8 | view.getUint8(6) << 16;
  };
  assert.deepEqual(replayStates.map(replayFrame), [1, 2],
    "replay boosts preserve the original logical race frames");
  const replaySpeed = new DataView(replayStates[1]).getFloat32(7, true);
  replaySelf.postMessage({ messageType: 10, carStateBuffers: [replayStates[1]] });
  assert.ok(Math.abs(new DataView(replayStates[1]).getFloat32(7, true) -
    replaySpeed * 1.2) < 0.001, "the recorded HUD speed setting is also restored");
  assert.equal(replayMessages.at(-1).messageType, 10);

  const reducedReplaySettings = {
    accelerationMultiplier: 0.9, brakingMultiplier: 1, topSpeedMultiplier: 1,
  };
  replaySelf.onmessage({
    data: {
      messageType: 3, carId: 15, carRecording: "reduced-controls",
      replayBoostSettings: reducedReplaySettings, __polytrackReplayWorker: true,
    },
  });
  const reducedReplay = replaySelf.__test.addCar(
    15, {}, null, reducedReplaySettings,
  );
  assert.equal(reducedReplay.boost, true);
  assert.equal(reducedReplay.boostFrameCorrection, false,
    "reduced controls do not need accelerated-frame correction");
  for (let tick = 0; tick < 10; tick += 1) {
    replaySelf.__test.a(reducedReplay, {
      up: true, right: false, down: false, left: false, reset: false,
      frame: tick + 1,
    });
    reducedReplay.frames += 1;
  }
  assert.equal(
    replaySelf.__test.t.motion.get(15).accelerationUpdates,
    9,
    "a 90% replay skips one accelerator update in ten",
  );

  assert.equal(boosted.boost, true);
  assert.equal(boosted.boostFrameCorrection, true);
  assert.equal(ghost.boost, false);
  let playerPhysicsState;
  let ghostPhysicsState;
  for (let tick = 0; tick < 10; tick += 1) {
    playerPhysicsState = self.__test.a(boosted, self.__test.realtime(boosted).controls);
    boosted.frames += 1;
    ghost.frames += 1;
    ghostPhysicsState = self.__test.a(ghost, { ...controls, boost: true });
  }
  assert.equal(self.__test.t.calls.filter((id) => id === 7).length, 15);
  assert.equal(self.__test.t.calls.filter((id) => id === 8).length, 10);
  assert.ok(
    self.__test.t.motion.get(7).distance > self.__test.t.motion.get(8).distance,
    "extra player physics updates change simulated vehicle motion",
  );
  function readFrame(view, offset) {
    return view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
  }
  const playerPhysicsView = new DataView(playerPhysicsState);
  assert.equal(readFrame(playerPhysicsView, 4), 10, "displayed frame time stays at logical frames");
  assert.equal(readFrame(playerPhysicsView, 12), 4, "finish time stays at the logical finish frame");
  const ghostPhysicsView = new DataView(ghostPhysicsState);
  assert.equal(readFrame(ghostPhysicsView, 4), 10, "ghost frame time remains unmodified");

  self.onmessage({
    data: {
      messageType: 6, carId: 7, up: true, accelerationBoost: true,
      accelerationMultiplier: 2, brakingMultiplier: 1, topSpeedMultiplier: 1.7,
    },
  });
  playerPhysicsState = self.__test.a(boosted, self.__test.realtime(boosted).controls);
  boosted.frames += 1;
  assert.equal(self.__test.t.calls.filter((id) => id === 7).length, 17,
    "2x acceleration adds one physics update on every logical frame");
  assert.equal(readFrame(new DataView(playerPhysicsState), 4), 11,
    "dynamic multiplier changes do not accelerate the logical timer");

  self.onmessage({
    data: {
      messageType: 6, carId: 7, up: false, down: true, accelerationBoost: true,
      accelerationMultiplier: 2, brakingMultiplier: 1.5, topSpeedMultiplier: 1.7,
    },
  });
  for (let tick = 0; tick < 2; tick += 1) {
    playerPhysicsState = self.__test.a(boosted, self.__test.realtime(boosted).controls);
    boosted.frames += 1;
  }
  assert.equal(self.__test.t.calls.filter((id) => id === 7).length, 20,
    "braking multiplier adds updates only while braking");
  assert.equal(self.__test.t.motion.get(7).brakingUpdates, 3,
    "braking updates reduce the simulated vehicle's actual speed");
  assert.ok(self.__test.t.motion.get(7).speed < 30,
    "braking changes physical speed rather than only the reported value");
  assert.equal(readFrame(new DataView(playerPhysicsState), 4), 13,
    "braking boost also preserves logical race time");

  const batchedControls = [];
  for (let tick = 0; tick < 4; tick += 1) {
    batchedControls.push(self.__test.realtime(boosted).controls);
    boosted.frames += 1;
  }
  const batchedFrames = batchedControls.map((frameControls) => {
    const state = self.__test.a(boosted, frameControls);
    return readFrame(new DataView(state), 4);
  });
  assert.deepEqual(batchedFrames, [14, 15, 16, 17],
    "batched updates keep the individual logical frame for every emitted state");

  self.onmessage({
    data: {
      messageType: 6, carId: 7, up: true, accelerationBoost: false,
      accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1.7,
    },
  });
  playerPhysicsState = self.__test.a(boosted, self.__test.realtime(boosted).controls);
  boosted.frames += 1;
  assert.equal(readFrame(new DataView(playerPhysicsState), 4), 18,
    "logical frame correction remains active after physics boost is disabled");
  const repeatedFrameState = self.__test.a(boosted, { ...controls, frame: 18 });
  const missingFrameState = self.__test.a(boosted, controls);
  assert.equal(readFrame(new DataView(repeatedFrameState), 4), 19,
    "repeated frame metadata falls back to the next increasing logical frame");
  assert.equal(readFrame(new DataView(missingFrameState), 4), 20,
    "missing frame metadata also preserves monotonic player frames");

  function simulateWithTopSpeed(topSpeedMultiplier, carId) {
    const controls = { up: true, right: false, down: false, left: false, reset: false };
    self.onmessage({ data: { messageType: 3, carId, carRecording: null } });
    const car = self.__test.addCar(carId, {}, { ...controls });
    self.onmessage({
      data: {
        messageType: 6, carId, up: true, accelerationBoost: false,
        accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier,
      },
    });
    let peakSpeedState;
    for (let tick = 0; tick < 4; tick += 1) {
      peakSpeedState = self.__test.a(car, self.__test.realtime(car).controls);
      car.frames += 1;
    }
    self.postMessage({ messageType: 10, carStateBuffers: [peakSpeedState] });
    self.onmessage({
      data: {
        messageType: 6, carId, up: false, down: true, accelerationBoost: false,
        accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier,
      },
    });
    let brakingState;
    for (let tick = 0; tick < 2; tick += 1) {
      brakingState = self.__test.a(car, self.__test.realtime(car).controls);
      car.frames += 1;
    }
    return {
      motion: { ...self.__test.t.motion.get(carId) },
      peakSpeed: new DataView(peakSpeedState).getFloat32(7, true) * topSpeedMultiplier,
      brakingState,
    };
  }

  const normalTopSpeed = simulateWithTopSpeed(1, 9);
  const increasedTopSpeed = simulateWithTopSpeed(1.7, 10);
  assert.deepEqual(
    increasedTopSpeed.motion,
    normalTopSpeed.motion,
    "top-speed display scaling currently leaves native acceleration, braking, and distance unchanged",
  );
  assert.ok(
    increasedTopSpeed.peakSpeed > normalTopSpeed.peakSpeed,
    "the current top-speed multiplier changes only the reported speed",
  );
  assert.equal(readFrame(new DataView(normalTopSpeed.brakingState), 4), 6);
  assert.equal(readFrame(new DataView(increasedTopSpeed.brakingState), 4), 6);

  const boostTimeline = {
    version: 1,
    segments: [
      { startFrame: 1, endFrame: 1, accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 },
      { startFrame: 2, endFrame: 2, accelerationMultiplier: 2, brakingMultiplier: 1, topSpeedMultiplier: 1.2 },
      { startFrame: 3, endFrame: 3, accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 },
    ],
  };
  self.onmessage({
    data: {
      messageType: 3, carId: 14, carRecording: "timeline-controls",
      replayBoostSettings: boostTimeline.segments[1],
      replayBoostTimeline: boostTimeline,
      __polytrackReplayWorker: true,
    },
  });
  const timelineCar = self.__test.addCar(
    14, {}, null, boostTimeline.segments[1], boostTimeline,
  );
  const timelineSpeeds = [];
  const callsBeforeTimeline = self.__test.t.calls.length;
  for (let frame = 1; frame <= 3; frame += 1) {
    const state = self.__test.a(timelineCar, {
      up: true, right: false, down: false, left: false, reset: false, frame,
    });
    timelineCar.frames += 1;
    self.postMessage({ messageType: 10, carStateBuffers: [state] });
    timelineSpeeds.push(new DataView(state).getFloat32(7, true));
  }
  assert.equal(self.__test.t.calls.length - callsBeforeTimeline, 4,
    "the timeline applies ordinary physics, boosted physics, then ordinary physics");
  assert.deepEqual(
    timelineSpeeds.map((speed) => Math.round(speed * 10) / 10),
    [2, 7.2, 8],
    "per-frame top-speed scaling follows the saved timeline and returns to normal",
  );
  assert.deepEqual(
    [1, 2, 3].map((frame) => self.__polytrackReplaySettingsAtFrame(boostTimeline, frame)
      .accelerationMultiplier),
    [1, 2, 1],
  );

  function packedState(id) {
    const buffer = new ArrayBuffer(11);
    const view = new DataView(buffer);
    view.setUint32(0, id, true);
    view.setUint8(4, 120);
    view.setFloat32(7, 100, true);
    return { buffer, view };
  }
  const playerState = packedState(7);
  self.postMessage({ messageType: 10, carStateBuffers: [playerState.buffer] });
  assert.equal(playerState.view.getUint8(4), 120, "player's frame counter is untouched");
  assert.equal(playerState.view.getFloat32(7, true), 170,
    "player speed uses the latest top-speed setting");
  const fasterPlayerState = packedState(7);
  self.postMessage({ messageType: 10, carStateBuffers: [fasterPlayerState.buffer] });
  assert.equal(fasterPlayerState.view.getFloat32(7, true), 170,
    "top-speed multiplier updates apply to the local player's speed value");
  const repeatedBatch = [packedState(7), packedState(7), packedState(7)];
  self.postMessage({
    messageType: 10,
    carStateBuffers: repeatedBatch.map(({ buffer }) => buffer),
  });
  assert.deepEqual(
    repeatedBatch.map(({ view }) => readFrame(view, 4)),
    [122, 123, 124],
    "duplicate frames in a packed worker batch are corrected monotonically",
  );
  const ghostState = packedState(8);
  childWorkers[0].onmessage({
    data: { messageType: 10, carStateBuffers: [ghostState.buffer] },
  });
  assert.equal(ghostState.view.getUint8(4), 120);
  assert.equal(ghostState.view.getFloat32(7, true), 100, "ghost speed is unchanged");
  const repeatedGhostBatch = [packedState(8), packedState(8)];
  childWorkers[0].onmessage({
    data: {
      messageType: 10,
      carStateBuffers: repeatedGhostBatch.map(({ buffer }) => buffer),
    },
  });
  assert.deepEqual(
    repeatedGhostBatch.map(({ view }) => readFrame(view, 4)),
    [121, 122],
    "repeated ghost frames are normalized without changing ghost physics",
  );
  assert.equal(repeatedGhostBatch[0].view.getFloat32(7, true), 100);

  const nonPlayerState = packedState(9);
  self.postMessage({ messageType: 10, carStateBuffers: [nonPlayerState.buffer] });
  const repeatedNonPlayerState = packedState(9);
  self.postMessage({
    messageType: 10,
    carStateBuffers: [repeatedNonPlayerState.buffer],
  });
  assert.deepEqual(
    [readFrame(nonPlayerState.view, 4), readFrame(repeatedNonPlayerState.view, 4)],
    [120, 121],
    "the output guard covers cars even when their create message was not observed",
  );
  assert.equal(nativeMessages.length, 12,
    "normalized player, non-player, timeline replay, and ghost states reach the game");
  self.onmessage({ data: { messageType: 4, carId: 8 } });
  assert.equal(childWorkers[0].messages.at(-1).messageType, 4, "ghost deletion stays isolated");
  self.onmessage({
    data: {
      messageType: 3, carId: 13, carRecording: "another-boosted-run",
      replayBoostSettings: {
        accelerationMultiplier: 2, brakingMultiplier: 1, topSpeedMultiplier: 1,
      },
    },
  });
  assert.equal(childWorkers.length, 3);
  assert.equal(childWorkers[2].url, "site-simulation-worker.js",
    "two boosted replays use separate physics worlds");
  self.onmessage({ data: { messageType: 4, carId: 12 } });
  assert.equal(childWorkers[1].messages.at(-1).messageType, 4,
    "boosted replay deletion stays isolated");
  assert.equal(childWorkers[1].terminated, true);
  assert.equal(childWorkers[2].terminated, undefined);
  self.onmessage({ data: { messageType: 4, carId: 13 } });
  assert.equal(childWorkers[2].terminated, true);

  self.onmessage({
    data: {
      messageType: 3, carId: 16, carRecording: "reduced-run",
      replayBoostSettings: {
        accelerationMultiplier: 0.9, brakingMultiplier: 1, topSpeedMultiplier: 1,
      },
    },
  });
  assert.equal(childWorkers.length, 4,
    "a 90% replay is routed through an isolated physics worker");
  assert.equal(childWorkers[3].messages[1].replayBoostSettings.accelerationMultiplier, 0.9);
  self.onmessage({ data: { messageType: 4, carId: 16 } });
  assert.equal(childWorkers[3].terminated, true);

  const reducedPlayer = self.__test.addCar(20, {}, { ...controls });
  self.onmessage({ data: { messageType: 3, carId: 20, carRecording: null } });
  self.onmessage({
    data: {
      messageType: 6, carId: 20, up: true, accelerationBoost: true,
      accelerationMultiplier: 0.9, brakingMultiplier: 1, topSpeedMultiplier: 1,
    },
  });
  assert.equal(reducedPlayer.boost, true);
  assert.equal(reducedPlayer.boostFrameCorrection, false);
  for (let tick = 0; tick < 10; tick += 1) {
    self.__test.a(reducedPlayer, self.__test.realtime(reducedPlayer).controls);
    reducedPlayer.frames += 1;
  }
  assert.equal(
    self.__test.t.motion.get(20).accelerationUpdates,
    9,
    "a live 90% setting skips one accelerator update in ten",
  );

  const precisePlayer = self.__test.addCar(21, {}, { ...controls });
  self.onmessage({ data: { messageType: 3, carId: 21, carRecording: null } });
  self.onmessage({
    data: {
      messageType: 6, carId: 21, up: true, accelerationBoost: true,
      accelerationMultiplier: 1.01, brakingMultiplier: 1, topSpeedMultiplier: 1,
    },
  });
  for (let tick = 0; tick < 100; tick += 1) {
    self.__test.a(precisePlayer, self.__test.realtime(precisePlayer).controls);
    precisePlayer.frames += 1;
  }
  assert.equal(
    self.__test.t.motion.get(21).accelerationUpdates,
    101,
    "101% remains distinct from 100% in the physics worker",
  );

  let dataViewCreations = 0;
  class CountingDataView extends DataView {
    constructor(...args) {
      super(...args);
      dataViewCreations += 1;
    }
  }
  const performanceMessages = [];
  const performanceSelf = {
    onmessage: null,
    postMessage(message) { performanceMessages.push(message); },
  };
  const performanceContext = {
    self: performanceSelf,
    fetch: async () => ({ text: async () => fixture }),
    DataView: CountingDataView,
    Set,
    Array,
    Worker: ChildWorker,
  };
  Object.defineProperty(performanceContext, "onmessage", {
    get() { return performanceSelf.onmessage; },
    set(handler) { performanceSelf.onmessage = handler; },
  });
  vm.runInNewContext(wrapper, performanceContext);
  performanceSelf.onmessage({ data: { messageType: 0, isRealtime: true } });
  await new Promise((resolve) => setImmediate(resolve));
  const neutralControls = {
    up: false, right: false, down: false, left: false, reset: false,
  };
  const neutralCar = performanceSelf.__test.addCar(22, {}, neutralControls);
  performanceSelf.onmessage({
    data: { messageType: 3, carId: 22, carRecording: null },
  });
  performanceSelf.onmessage({
    data: {
      messageType: 6, carId: 22, ...neutralControls,
      accelerationBoost: false,
      accelerationMultiplier: 1,
      brakingMultiplier: 1,
      topSpeedMultiplier: 1,
    },
  });
  const neutralState = performanceSelf.__test.a(
    neutralCar,
    performanceSelf.__test.realtime(neutralCar).controls,
  );
  const dataViewsBeforeOutput = dataViewCreations;
  performanceSelf.postMessage({
    messageType: 10,
    carStateBuffers: [neutralState],
  });
  assert.equal(
    dataViewCreations - dataViewsBeforeOutput,
    1,
    "neutral output only performs the required frame-normalization scan",
  );
  assert.equal(
    performanceMessages.at(-1).__polytrackBoostFrames,
    undefined,
    "normal runs do not allocate boost timeline metadata",
  );
});