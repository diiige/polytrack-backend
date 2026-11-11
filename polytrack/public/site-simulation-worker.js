(() => {
  "use strict";

  let nativeHandler = null;
  let initMessage = null;
  let ghostWorker = null;
  const boostedReplayWorkers = new Map();
  const pendingMessages = [];
  const boostedCars = new Set();
  const speedMultipliers = new Map();
  const boostSettingsByCar = new Map();
  const replayBoostTimelines = new Map();
  const recordingBoostTimelineCars = new Set();
  const controllableCars = new Set();
  const frameCorrectionCars = new Set();
  const outputFrames = new Map();
  const ghostOutputFrames = new Map();
  const ghostCars = new Set();
  const boostedReplayOutputFrames = new Map();
  const nativePostMessage = self.postMessage.bind(self);

  function normalizeMultiplier(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.round(Math.min(2, Math.max(0.9, number)) * 100) / 100
      : fallback;
  }

  function normalizeReplayBoostSettings(value) {
    const settings = normalizeBoostValues(value);
    if (!settings) return null;
    return Object.values(settings).some((multiplier) => multiplier !== 1)
      ? settings
      : null;
  }

  function normalizeBoostValues(value) {
    if (!value || typeof value !== "object") return null;
    return {
      accelerationMultiplier: normalizeMultiplier(value.accelerationMultiplier, 1),
      brakingMultiplier: normalizeMultiplier(value.brakingMultiplier, 1),
      topSpeedMultiplier: normalizeMultiplier(value.topSpeedMultiplier, 1),
    };
  }

  function normalizeReplayBoostTimeline(value) {
    if (!value || typeof value !== "object" || value.version !== 1 ||
        !Array.isArray(value.segments) || value.segments.length < 1 ||
        value.segments.length > 10_000) return null;
    const segments = [];
    let previousEndFrame = 0;
    let hasBoost = false;
    for (const segment of value.segments) {
      const settings = normalizeBoostValues(segment);
      if (!settings || !Number.isSafeInteger(segment.startFrame) ||
          !Number.isSafeInteger(segment.endFrame) || segment.startFrame < 1 ||
          segment.endFrame < segment.startFrame || segment.endFrame > 2_000_000 ||
          segment.startFrame <= previousEndFrame ||
          Object.keys(settings).some((key) =>
            typeof segment[key] !== "number" || !Number.isFinite(segment[key]) ||
            segment[key] < 0.9 || segment[key] > 2
          )) return null;
      previousEndFrame = segment.endFrame;
      hasBoost ||= Object.values(settings).some((multiplier) => multiplier !== 1);
      segments.push({
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        ...settings,
      });
    }
    return hasBoost ? { version: 1, segments } : null;
  }

  function replayBoostSettingsAtFrame(timeline, frame) {
    if (!timeline || !Number.isSafeInteger(frame)) return null;
    let low = 0;
    let high = timeline.segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = timeline.segments[middle];
      if (frame < segment.startFrame) {
        high = middle - 1;
      } else if (frame > segment.endFrame) {
        low = middle + 1;
      } else {
        return segment;
      }
    }
    return { accelerationMultiplier: 1, brakingMultiplier: 1, topSpeedMultiplier: 1 };
  }

  self.__polytrackSetNativeHandler = (handler) => {
    nativeHandler = handler;
  };

  function normalizeOutputFrames(message, framesByCar, forcedIncrementCars) {
    if (message?.messageType !== 10 || !Array.isArray(message.carStateBuffers)) {
      return;
    }

    for (const buffer of message.carStateBuffers) {
      const view = new DataView(buffer);
      const carId = view.getUint32(0, true);
      const currentFrame =
        view.getUint8(4) | view.getUint8(5) << 8 | view.getUint8(6) << 16;
      const previousFrame = framesByCar.get(carId);
      const frame = previousFrame === undefined
        ? currentFrame
        : forcedIncrementCars?.has(carId)
          ? previousFrame + 1
          : Math.max(currentFrame, previousFrame + 1);
      view.setUint8(4, frame & 255);
      view.setUint8(5, (frame >>> 8) & 255);
      view.setUint8(6, (frame >>> 16) & 255);
      framesByCar.set(carId, frame);
    }
  }

  function postMessageWithBoost(message, transfer) {
    normalizeOutputFrames(message, outputFrames, frameCorrectionCars);
    if (
      message?.messageType === 10 &&
      Array.isArray(message.carStateBuffers) &&
      (speedMultipliers.size > 0 ||
        replayBoostTimelines.size > 0 ||
        recordingBoostTimelineCars.size > 0)
    ) {
      const recordedBoostFrames = [];
      for (const buffer of message.carStateBuffers) {
        const view = new DataView(buffer);
        const carId = view.getUint32(0, true);
        const frame =
          view.getUint8(4) | view.getUint8(5) << 8 | view.getUint8(6) << 16;
        const timeline = replayBoostTimelines.get(carId);
        const frameSettings = timeline
          ? replayBoostSettingsAtFrame(timeline, frame)
          : null;
        const speedMultiplier =
          frameSettings?.topSpeedMultiplier ?? speedMultipliers.get(carId) ?? 1;
        if (speedMultiplier !== 1) {
          // The 4-byte car ID is followed by a 3-byte frame counter. Speed
          // starts at byte 7 in the packed car-state buffer.
          view.setFloat32(7, view.getFloat32(7, true) * speedMultiplier, true);
        }
        if (recordingBoostTimelineCars.has(carId)) {
          const settings = boostSettingsByCar.get(carId);
          if (settings) recordedBoostFrames.push({ carId, frame, settings });
        }
      }
      if (recordedBoostFrames.length > 0) {
        message.__polytrackBoostFrames = recordedBoostFrames;
      }
    }
    if (transfer === undefined) {
      return nativePostMessage(message);
    }
    return nativePostMessage(message, transfer);
  }

  function createBoostedReplayWorker(carId) {
    // Each boosted ghost needs its own WASM world: extra physics updates for
    // one car can otherwise move the other cars sharing that world.
    boostedReplayWorkers.get(carId)?.terminate();
    const worker = new Worker("site-simulation-worker.js");
    worker.onmessage = ({ data }) => {
      if (data?.messageType === 10 && Array.isArray(data.carStateBuffers)) {
        normalizeOutputFrames(data, boostedReplayOutputFrames);
        nativePostMessage(data, { transfer: data.carStateBuffers });
      } else {
        nativePostMessage(data);
      }
    };
    worker.postMessage(initMessage);
    boostedReplayWorkers.set(carId, worker);
    return worker;
  }

  function handleMessage(event) {
    if (!nativeHandler) {
      pendingMessages.push(event);
      return;
    }
    const message = event.data;
    if (message?.messageType === 0) {
      initMessage = message;
      nativeHandler(event);
      return;
    }
    if (message?.messageType === 3) {
      if (message.carRecording != null) {
        const replayBoostTimeline =
          normalizeReplayBoostTimeline(message.replayBoostTimeline);
        const replayBoostSettings =
          normalizeReplayBoostSettings(message.replayBoostSettings);
        if (message.__polytrackReplayWorker) {
          outputFrames.delete(message.carId);
          frameCorrectionCars.delete(message.carId);
          if (replayBoostSettings?.accelerationMultiplier > 1 ||
              replayBoostSettings?.brakingMultiplier > 1 ||
              replayBoostTimeline?.segments.some((segment) =>
                segment.accelerationMultiplier > 1 || segment.brakingMultiplier > 1
              )) {
            frameCorrectionCars.add(message.carId);
          }
          if (replayBoostTimeline) {
            speedMultipliers.delete(message.carId);
            replayBoostTimelines.set(message.carId, replayBoostTimeline);
          } else {
            replayBoostTimelines.delete(message.carId);
            if (
              replayBoostSettings &&
              replayBoostSettings.topSpeedMultiplier !== 1
            ) {
              speedMultipliers.set(
                message.carId,
                replayBoostSettings.topSpeedMultiplier,
              );
            } else {
              speedMultipliers.delete(message.carId);
            }
          }
        } else {
          if (!initMessage) throw new Error("Ghost worker was not initialized");
          if (replayBoostSettings || replayBoostTimeline) {
            const firstBoostedSettings = replayBoostTimeline?.segments.find((segment) =>
              segment.accelerationMultiplier !== 1 || segment.brakingMultiplier !== 1 ||
              segment.topSpeedMultiplier !== 1
            );
            boostedReplayOutputFrames.delete(message.carId);
            createBoostedReplayWorker(message.carId).postMessage({
              ...message,
              ...(replayBoostSettings
                ? { replayBoostSettings }
                : firstBoostedSettings ? { replayBoostSettings: firstBoostedSettings } : {}),
              ...(replayBoostTimeline ? { replayBoostTimeline } : {}),
              __polytrackReplayWorker: true,
            });
          } else {
            if (!ghostWorker) {
              // Ordinary replays need the same community-track registry patch
              // as the player worker, while keeping neutral physics without
              // per-record boost metadata.
              ghostWorker = new Worker("site-simulation-worker.js");
              ghostWorker.onmessage = ({ data }) => {
                if (data?.messageType === 10 && Array.isArray(data.carStateBuffers)) {
                  normalizeOutputFrames(data, ghostOutputFrames);
                  nativePostMessage(data, { transfer: data.carStateBuffers });
                } else {
                  nativePostMessage(data);
                }
              };
              ghostWorker.postMessage(initMessage);
            }
            ghostCars.add(message.carId);
            ghostOutputFrames.delete(message.carId);
            ghostWorker.postMessage({
              ...message,
              __polytrackReplayWorker: true,
            });
          }
          return;
        }
      } else {
        controllableCars.add(message.carId);
        outputFrames.delete(message.carId);
        frameCorrectionCars.delete(message.carId);
      }
    }
    const boostedReplayWorker = boostedReplayWorkers.get(message?.carId);
    if (boostedReplayWorker) {
      boostedReplayWorker.postMessage(message);
      if (message.messageType === 4) {
        boostedReplayWorker.terminate();
        boostedReplayWorkers.delete(message.carId);
        boostedReplayOutputFrames.delete(message.carId);
        replayBoostTimelines.delete(message.carId);
        speedMultipliers.delete(message.carId);
        frameCorrectionCars.delete(message.carId);
      }
      return;
    }
    if (ghostCars.has(message?.carId)) {
      ghostWorker.postMessage(message);
      if (message.messageType === 4) {
        ghostCars.delete(message.carId);
        ghostOutputFrames.delete(message.carId);
      }
      return;
    }
    if (message?.messageType === 6) {
      const isControllable = controllableCars.has(message.carId);
      const accelerationMultiplier = normalizeMultiplier(
        message.accelerationMultiplier,
        message.accelerationBoost ? 1.5 : 1,
      );
      const brakingMultiplier = normalizeMultiplier(message.brakingMultiplier, 1);
      if (isControllable && (accelerationMultiplier !== 1 || brakingMultiplier !== 1)) {
        boostedCars.add(message.carId);
      } else {
        boostedCars.delete(message.carId);
      }
      if (isControllable && (accelerationMultiplier > 1 || brakingMultiplier > 1)) {
        frameCorrectionCars.add(message.carId);
      }
      if (isControllable) {
        const topSpeedMultiplier = normalizeMultiplier(
          message.topSpeedMultiplier,
          message.accelerationBoost ? 1.2 : 1,
        );
        const hasBoostSettings =
          accelerationMultiplier !== 1 ||
          brakingMultiplier !== 1 ||
          topSpeedMultiplier !== 1;
        if (hasBoostSettings) {
          boostSettingsByCar.set(message.carId, {
            accelerationMultiplier,
            brakingMultiplier,
            topSpeedMultiplier,
          });
          recordingBoostTimelineCars.add(message.carId);
        } else {
          boostSettingsByCar.delete(message.carId);
          recordingBoostTimelineCars.delete(message.carId);
        }
        if (topSpeedMultiplier !== 1) {
          speedMultipliers.set(message.carId, topSpeedMultiplier);
        } else {
          speedMultipliers.delete(message.carId);
        }
      } else {
        boostSettingsByCar.delete(message.carId);
        speedMultipliers.delete(message.carId);
        recordingBoostTimelineCars.delete(message.carId);
      }
    } else if (message?.messageType === 4) {
      controllableCars.delete(message.carId);
      boostedCars.delete(message.carId);
      speedMultipliers.delete(message.carId);
      boostSettingsByCar.delete(message.carId);
      replayBoostTimelines.delete(message.carId);
      recordingBoostTimelineCars.delete(message.carId);
      frameCorrectionCars.delete(message.carId);
      outputFrames.delete(message.carId);
    }
    nativeHandler(event);
  }

  self.onmessage = handleMessage;

  fetch("simulation_worker.bundle.js")
    .then((response) => response.text())
    .then((source) => {
      const finalExistingTrackPart =
        't[t.PlaneWallSlopeDownLongRight=187]="PlaneWallSlopeDownLongRight"';
      const planeSlopeUpTrackPart =
        'new lo("2dda4d3801c9cd4c117dc3c8239bea28cafe70ef2127986c2d6b455744fc8019",Xa.Plane,Za.PlaneSlopeUp,[["Planes","PlaneSlopeUp"]],ao,[[[-2,0,-2],[1,0,1]],[[-2,1,-2],[1,1,-2]]])';
      const blockSlopeVerticalBottomTrackPart =
        'new lo("cc9c95eef56def4cf013e4ac85b8013a2b4f4b4346f1f5dd41fa017de763ef17",Xa.Block,Za.BlockSlopeVerticalCornerBottom,[["Blocks","BlockSlopeVerticalCornerBottom"]],oo,[[[-2,0,-2],[1,0,1]],[[-2,1,-2],[0,1,0]],[[1,1,-2],[1,1,-1]],[[-2,1,1],[-1,1,1]],[[-2,2,-2],[-1,2,-1]],[[-2,2,0],[-1,2,0]],[[0,2,-2],[0,2,-1]],[[1,2,-2],[1,2,-2]],[[-2,2,1],[-2,2,1]],[[-2,3,-2],[-1,3,-1]],[[-2,3,0],[-2,3,1]],[[0,3,-2],[1,3,-2]]])';
      const planeCornerTrackPart =
        'new lo("f6809dcb8440d3c6043bfd91eb84add7facf61565ce4fd6c2aa73a5a9da32934",Xa.Plane,Za.PlaneCorner,[["Planes","PlaneCorner"]],ao,[[[-2,0,-1],[1,0,1]],[[-1,0,-2],[1,0,-2]]])';
      const blockOuterCornerTrackPart =
        'new lo("5e3b086f679fc9ff779abba9a7ea0db59a0a4dbd0540cd4aa501e2bfea1673f5",Xa.Block,Za.BlockOuterCorner,[["Blocks","BlockOuterCorner"]],oo,[[[-2,0,-1],[1,0,1]],[[-1,0,-2],[1,0,-2]]])';
      const updateCar = 'function a(e,i){t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,i.up,i.right,i.down,i.left,i.reset,n]);return new Uint8Array(t.HEAPU8.buffer,n,s).slice().buffer}';
      const boostedUpdateCar = 'function a(e,i){const w=Number.isSafeInteger(i.frame)&&i.frame>0?i.frame:(e.boostOutputFrame||0)+1,z=e.replayBoostTimeline?self.__polytrackReplaySettingsAtFrame(e.replayBoostTimeline,w):null;if(z){e.boost=z.accelerationMultiplier!==1||z.brakingMultiplier!==1,e.accelerationMultiplier=z.accelerationMultiplier,e.brakingMultiplier=z.brakingMultiplier}const q=e.boost?(i.down?e.brakingMultiplier:i.up?e.accelerationMultiplier:1):1;let u=i.up,d=i.down,o=0;if(q<1&&(i.up||i.down)){const r=(e.boostSlowRemainder||0)+Math.round(q*100);if(r<100){u=!1,d=!1,e.boostSlowRemainder=r}else e.boostSlowRemainder=r-100;e.boostRemainder=0}else{e.boostSlowRemainder=0;const r=q>1?(e.boostRemainder||0)+Math.round((q-1)*100):0;o=Math.floor(r/100);e.boostRemainder=q>1?r%100:0}t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,u,i.right,d,i.left,i.reset,n]);for(let l=0;l<o;l++)t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,i.up,i.right,i.down,i.left,i.reset,n]);const p=new Uint8Array(t.HEAPU8.buffer,n,s).slice(),f=w>(e.boostOutputFrame||0)?w:(e.boostOutputFrame||0)+1;e.boostOutputFrame=f;if(e.boostFrameCorrection){p[4]=f&255,p[5]=f>>>8&255,p[6]=f>>>16&255,p[11]&2&&(null==e.boostFinishFrames&&(e.boostFinishFrames=f),p[12]=e.boostFinishFrames&255,p[13]=e.boostFinishFrames>>>8&255,p[14]=e.boostFinishFrames>>>16&255)}return p.buffer}';
      const carState = "e.push({id:l,controls:s,userControls:n,hasStarted:!1,frames:0,targetSimulationFrames:null,isPaused:!1})";
      const boostedCarState = "e.push({id:l,controls:s,userControls:n,hasStarted:!1,frames:0,targetSimulationFrames:null,isPaused:!1,replayBoostTimeline:t.replayBoostTimeline,boost:Boolean(t.replayBoostSettings&&(Number(t.replayBoostSettings.accelerationMultiplier)!==1||Number(t.replayBoostSettings.brakingMultiplier)!==1)||t.replayBoostTimeline&&t.replayBoostTimeline.segments.some(e=>e.accelerationMultiplier!==1||e.brakingMultiplier!==1)),boostFrameCorrection:Boolean(t.replayBoostSettings&&(Number(t.replayBoostSettings.accelerationMultiplier)>1||Number(t.replayBoostSettings.brakingMultiplier)>1)||t.replayBoostTimeline&&t.replayBoostTimeline.segments.some(e=>e.accelerationMultiplier>1||e.brakingMultiplier>1)),accelerationMultiplier:Number(t.replayBoostSettings&&t.replayBoostSettings.accelerationMultiplier)||1,brakingMultiplier:Number(t.replayBoostSettings&&t.replayBoostSettings.brakingMultiplier)||1})";
      const controlStart = 'if(s.id==r){if(null==s.userControls)throw new Error("Tried to control uncontrollable car")';
      const boostedControlStart = 'if(s.id==r){if(null==s.userControls)throw new Error("Tried to control uncontrollable car");s.boost=Boolean(t.accelerationBoost);s.boostFrameCorrection=s.boostFrameCorrection||Boolean(t.accelerationMultiplier>1||t.brakingMultiplier>1);s.accelerationMultiplier=Number(t.accelerationMultiplier)||1.5;s.brakingMultiplier=Number(t.brakingMultiplier)||1';
      const realtimeControls = "controls:{up:t.userControls.up,right:t.userControls.right,down:t.userControls.down,left:t.userControls.left,reset:t.userControls.reset}";
      const boostedRealtimeControls = "controls:{up:t.userControls.up,right:t.userControls.right,down:t.userControls.down,left:t.userControls.left,reset:t.userControls.reset,frame:t.frames+1,boost:t.boost,accelerationMultiplier:t.accelerationMultiplier,brakingMultiplier:t.brakingMultiplier}";
      const bootHandler = "onmessage=t=>{il.push(t)}";
      const readyHandler = "il.length=0,onmessage=i";

      if (
        !source.includes(updateCar) ||
        !source.includes(carState) ||
        !source.includes(controlStart) ||
        !source.includes(realtimeControls) ||
        !source.includes(bootHandler) ||
        !source.includes(readyHandler)
      ) {
        throw new Error("Simulation worker patch target was not found");
      }

      if (
        source.split(finalExistingTrackPart).length - 1 !== 1 ||
        source.split(planeSlopeUpTrackPart).length - 1 !== 1 ||
        source.split(blockSlopeVerticalBottomTrackPart).length - 1 !== 1 ||
        source.includes("BlockOuterCorner=188") ||
        source.includes("PlaneCorner=189") ||
        source.includes(planeCornerTrackPart) ||
        source.includes(blockOuterCornerTrackPart)
      ) {
        throw new Error("Simulation worker 0.6.1 track-part patch target was not found");
      }

      self.__polytrackReplaySettingsAtFrame = replayBoostSettingsAtFrame;
      const trackPatchedSource = source
        .replace(
          finalExistingTrackPart,
          `${finalExistingTrackPart},t[t.BlockOuterCorner=188]="BlockOuterCorner",t[t.PlaneCorner=189]="PlaneCorner"`,
        )
        .replace(
          planeSlopeUpTrackPart,
          `${planeCornerTrackPart},${planeSlopeUpTrackPart}`,
        )
        .replace(
          blockSlopeVerticalBottomTrackPart,
          `${blockOuterCornerTrackPart},${blockSlopeVerticalBottomTrackPart}`,
        );
      const patchedSource = trackPatchedSource
        .replace(updateCar, boostedUpdateCar)
        .replace(carState, boostedCarState)
        .replace(controlStart, boostedControlStart)
        .replace(realtimeControls, boostedRealtimeControls)
        // The bundle installs its real handler after the WASM loads. Keep
        // our routing hook active instead of letting that assignment replace it.
        .replace(bootHandler, "self.__polytrackSetNativeHandler(t=>{il.push(t)})")
        .replace(readyHandler, "il.length=0,self.__polytrackSetNativeHandler(i)");
      self.postMessage = postMessageWithBoost;
      (0, eval)(patchedSource);
      for (const event of pendingMessages.splice(0)) {
        handleMessage(event);
      }
    })
    .catch((error) => {
      throw error;
    });
})();