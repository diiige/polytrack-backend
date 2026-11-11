import { communityTrackImports } from "./community-track-imports.js";

const callbackStart =
  "I.n_().then((()=>{t.loadedResource()})),t.addCompleteListener((()=>{if(E.cleanUpRecords(),I.R_(),Pt.EM){";
const callbackEnd = "q(e)}}}));const a=i(7780);";
const profileStoreInitialization = "const E=new rd(e,w,S,x),T=new ne";
const carStateConsumer =
  "const e=t.carStateBuffers.map((e=>{const t=new Uint8Array(e);return{id:t[0]|t[1]<<8|t[2]<<16|t[3]<<24,carState:g.VO(t.subarray(4)).carState}}));for(const{id:t,carState:n}of e)t==m&&l(n)";
const carStateConsumerReplacement =
  'for(const r of t.carStateBuffers){const a=new Uint8Array(r);if((a[0]|a[1]<<8|a[2]<<16|a[3]<<24)===m){const c=g.VO(a.subarray(4)).carState,e=A.lastFrame;c.frames=e===undefined?c.frames:Math.max(c.frames,e+1);A.lastFrame=c.frames;l(c)}}';
const devicePixelDensitySetting =
  'e=(0,i.gn)(this,S,"f")?.getSettingBoolean(V.A.ScreenPixelDensity)??1?window.devicePixelRatio:1;';
const cappedDevicePixelDensitySetting =
  'e=(0,i.gn)(this,S,"f")?.getSettingBoolean(V.A.ScreenPixelDensity)??1?Math.min(window.devicePixelRatio||1,1.5):1;';
const savedRecordingLoad =
  "const d=re.A.deserialize(s.recording);return null==d?null:{uploadId:o,time:h,recording:d}";
const recordingCarMessage = "carRecording:s?.serialize()??null";
const replayViewStart = 'new Fp((0,R.gn)(this,Pf,"f").element,';
const replayViewEnd =
  'dispose(){(0,R.gn)(this,Bp,"f").removeChild((0,R.gn)(this,Gp,"f"))}';
const singleInstanceGuard =
  'if(!Pt.EM)try{if(void 0!==window.BroadcastChannel){const e=new window.BroadcastChannel("polytrack-single-instance");e.addEventListener("message",(t=>{"new-instance"==t.data&&ul&&e.postMessage("conflict"),"conflict"==t.data&&(ul=!1)})),e.postMessage("new-instance"),window.addEventListener("beforeunload",(()=>{e.close()}))}}catch(e){console.error(e)}let ul=!0;';
const singleInstanceGate = "ul?c.determinismState";
const singleInstancePrompt =
  ':u.showNoButtons(e.get("You already have another instance of PolyTrack open.")+"\\n\\n"+e.get("Please switch to that tab or window to continue."))';
const communityTrackMarker =
  '{id:"6f341a64070d52a00435604bfe79ee1f6d736c83511c426a1637e21d32e48c15"';
const supersededCommunityTrackEntries = [
  '{id:"984bb1361ed45e000120aa0199f6f1ef21d5f6482f76c948df369758ac47f7e8",group:"0.5.1",trackMetadata:{name:"Flying Dreams",author:"Forty, Shovelfish, Hero",lastModified:null},environment:hl.A.Summer,trackUrl:"main/tracks/community/flying_dreams.track",thumbnail:"main/tracks/community/thumbnails/flying_dreams.png"}',
  '{id:"00d39d287da724b1c6b69eab85379f44ee4ae2fc0876343666b944cf4c3156e5",group:"0.5.0",trackMetadata:{name:"Re : Akina",author:"Marcus",lastModified:null},environment:hl.A.Summer,trackUrl:"main/tracks/community/re_akina.track",thumbnail:"main/tracks/community/thumbnails/re_akina.png"}',
];
const shardmirTrackEntry =
  '{id:"b8e8e83ddce68a174ca6a544c658a29c613f09c126bc83a8800383961033f36f",group:"0.5.2",trackMetadata:{name:"ShardMir",author:"Jurre",lastModified:null},environment:hl.A.Desert,trackUrl:"main/tracks/community/shardmir.track",thumbnail:"main/tracks/community/thumbnails/shardmir.png"},';
const starryTropicsRegistryEntry =
  'id:"a6b990137e404c9ef2cb4399c463acbed8ebfa3bb82ab5315027118604c4ec03",group:"0.5.2",trackMetadata:{name:"Starry Tropics",author:"Leaf, Forty, WB",lastModified:new Date("2026-02-16T04:37:25.000Z")}';
const starryTropisxRegistryEntry = starryTropicsRegistryEntry.replace(
  'name:"Starry Tropics"',
  'name:"Starry Tropisx"',
);
const finalExistingTrackPart =
  'e[e.PlaneWallSlopeDownLongRight=187]="PlaneWallSlopeDownLongRight"';
const planeSlopeUpTrackPart =
  'new d("2dda4d3801c9cd4c117dc3c8239bea28cafe70ef2127986c2d6b455744fc8019",r.A.Plane,s.A.PlaneSlopeUp';
const blockSlopeVerticalBottomTrackPart =
  'new d("cc9c95eef56def4cf013e4ac85b8013a2b4f4b4346f1f5dd41fa017de763ef17",r.A.Block,s.A.BlockSlopeVerticalCornerBottom';
const planeCornerTrackPart =
  'new d("f6809dcb8440d3c6043bfd91eb84add7facf61565ce4fd6c2aa73a5a9da32934",r.A.Plane,s.A.PlaneCorner,[["Planes","PlaneCorner"]],c,[[[-2,0,-1],[1,0,1]],[[-1,0,-2],[1,0,-2]]])';
const blockOuterCornerTrackPart =
  'new d("5e3b086f679fc9ff779abba9a7ea0db59a0a4dbd0540cd4aa501e2bfea1673f5",r.A.Block,s.A.BlockOuterCorner,[["Blocks","BlockOuterCorner"]],h,[[[-2,0,-1],[1,0,1]],[[-1,0,-2],[1,0,-2]]])';
const profileNicknameSaveAnchor =
  '(0,i.gn)(this,se,"f")&&((0,i.gn)(this,Hn,"f").setNickname((0,i.gn)(this,ee,"f"))';
const profileNicknameInputAnchor =
  '(0,i.gn)(this,j,"f").type="text",(0,i.gn)(this,j,"f").placeholder=E.A.defaultNickname';
const profileNicknameInputLimit =
  'for(;(0,A.k)(t)>=50;)t=t.substring(0,t.length-1)';
const iceServerCredentialsAnchor = "r.push({urls:n})";
const iceServerCredentialsReplacement =
  'const iceServer={urls:n};for(const key of ["username","credential","credentialType"])key in e&&(iceServer[key]=e[key]);r.push(iceServer)';
const hostIceCandidateAnchor =
  'c.onicecandidate=t=>{null!=t.candidate&&(c.onicecandidate=t=>{o.send(JSON.stringify({version:Pt.rE,type:"iceCandidate",session:e,candidate:t.candidate}))})}';
const hostIceCandidateReplacement =
  'c.onicecandidate=t=>{null!=t.candidate&&o.send(JSON.stringify({version:Pt.rE,type:"iceCandidate",session:e,candidate:t.candidate}))}';
const personalBestRefreshAnchor =
  '((e,t)=>{null==e||null!=v&&!e.time.lessOrEqual(v.time)?(0,R.gn)(this,Vo,"m",ol).call(this,v?.time??null,null):(0,R.gn)(this,Vo,"m",ol).call(this,e.time,{position:e.position,total:t})})';
const personalBestRefreshReplacement = personalBestRefreshAnchor.replace(
  '((e,t)=>{',
  '((e,t)=>{const v=r.getRecord(i.profileSlot,h);',
);
const leaderboardRootAnchor =
  '(0,R.gn)(this,yo,"f").className="leaderboard-ui",e.appendChild';
const leaderboardRootReplacement =
  '(0,R.gn)(this,yo,"f").className="leaderboard-ui",(0,R.gn)(this,yo,"f").__polytrackPreparePbDeletion=()=>{(0,R.gn)(this,ko,"f")?.cancel();(0,R.GG)(this,Mo,!0,"f")},(0,R.gn)(this,yo,"f").__polytrackRefreshLeaderboard=()=>(0,R.gn)(this,lo,"m",zo).call(this,!1),(0,R.gn)(this,yo,"f").__polytrackResetLeaderboardPage=()=>{(0,R.GG)(this,Co,0,"f"),(0,R.gn)(this,lo,"m",Do).call(this),(0,R.gn)(this,lo,"m",zo).call(this,!1)},e.appendChild';

// Injected into the compiled game so deletion uses its live identity and waits
// for its own pending uploads/downloads, not just the site's migration helper.
export function installPolytrackPbBridge(browserWindow, profiles, records, namespace) {
  const pendingWrites = new Set();
  browserWindow.__polytrackGetActiveProfile = () => {
    const profile = profiles.getCurrentUserProfile();
    return {
      key: `${namespace}user_${profiles.profileSlot}`,
      profile: {
        token: profile.token,
        nickname: profile.nickname,
        countryCode: profile.countryCode,
        carStyle: profile.carStyle.serialize(),
      },
    };
  };
  for (const method of ["syncRecord", "setRecord"]) {
    const original = records[method].bind(records);
    records[method] = (...args) => {
      const result = original(...args);
      const entry = { slot: args[0], trackId: args[1], promise: Promise.resolve(result) };
      pendingWrites.add(entry);
      entry.promise.then(
        () => pendingWrites.delete(entry),
        () => pendingWrites.delete(entry),
      );
      return result;
    };
  }
  browserWindow.__polytrackWaitForRecordWrites = async (trackId) => {
    const slot = profiles.profileSlot;
    let pending;
    while ((pending = [...pendingWrites].filter(
      (entry) => entry.slot === slot && entry.trackId === trackId,
    )).length) {
      await Promise.allSettled(pending.map((entry) => entry.promise));
    }
  };
}

function serializeCommunityTrackEntry(entry) {
  const lastModified =
    entry.lastModified === null
      ? "null"
      : `new Date(${JSON.stringify(entry.lastModified)})`;

  return `{id:${JSON.stringify(entry.id)},group:${JSON.stringify(entry.group)},trackMetadata:{name:${JSON.stringify(entry.name)},author:${JSON.stringify(entry.author)},lastModified:${lastModified}},environment:hl.A.${entry.environment},trackUrl:${JSON.stringify(`main/tracks/community/${entry.assetFile}`)},thumbnail:${JSON.stringify(`main/tracks/community/thumbnails/${entry.assetFile.replace(/\.track$/, ".png")}`)}}`;
}

const communityTrackEntries = [...communityTrackImports]
  .sort((left, right) =>
    Number(right.group === "0.6.3") - Number(left.group === "0.6.3"),
  )
  .map(serializeCommunityTrackEntry)
  .join(",");

export function patchPolytrackMainBundle(source) {
  if (source.split(replayViewStart).length - 1 !== 1 ||
      source.split(replayViewEnd).length - 1 !== 1) {
    throw new Error("PolyTrack replay-view lifecycle patch target was not found uniquely");
  }
  if (source.split(callbackStart).length - 1 !== 1 ||
      source.split(callbackEnd).length - 1 !== 1 ||
      source.split(profileStoreInitialization).length - 1 !== 1 ||
      source.split(carStateConsumer).length - 1 !== 1 ||
      source.split(devicePixelDensitySetting).length - 1 !== 1 ||
      source.split(savedRecordingLoad).length - 1 !== 1 ||
      source.split(recordingCarMessage).length - 1 !== 1) {
    throw new Error("Polytrack startup callback patch target was not found uniquely");
  }

  if (
    source.split(singleInstanceGuard).length - 1 !== 1 ||
    source.split(singleInstanceGate).length - 1 !== 1 ||
    source.split(singleInstancePrompt).length - 1 !== 1
  ) {
    throw new Error("PolyTrack multi-instance restriction patch target was not found uniquely");
  }

  if (source.split(iceServerCredentialsAnchor).length - 1 !== 1) {
    throw new Error("PolyTrack ICE credentials patch target was not found uniquely");
  }

  if (source.split(hostIceCandidateAnchor).length - 1 !== 1) {
    throw new Error("PolyTrack host ICE candidate patch target was not found uniquely");
  }

  if (source.split(personalBestRefreshAnchor).length - 1 !== 1 ||
      source.split(leaderboardRootAnchor).length - 1 !== 1) {
    throw new Error("PolyTrack personal-best refresh patch target was not found uniquely");
  }

  if (
    source.split(communityTrackMarker).length - 1 !== 1 ||
    supersededCommunityTrackEntries.some(
      (entry) => source.split(`${entry},`).length - 1 !== 1,
    ) ||
    source.includes('id:"b8e8e83ddce68a174ca6a544c658a29c613f09c126bc83a8800383961033f36f"') ||
    source.split(starryTropicsRegistryEntry).length - 1 !== 1 ||
    communityTrackImports.some((entry) => source.includes(`id:"${entry.id}"`))
  ) {
    throw new Error("Community track registry patch target was not found uniquely");
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
    throw new Error("PolyTrack 0.6.1 track-part patch target was not found uniquely");
  }

  const sourceWithoutSupersededTracks = supersededCommunityTrackEntries.reduce(
    (patchedSource, entry) => patchedSource.replace(`${entry},`, ""),
    source,
  );

  return sourceWithoutSupersededTracks
    .replace(
      replayViewStart,
      'new Fp((window.__polytrackStartReplayWatch?.((0,R.gn)(this,kf,"f").map((e=>e.settings.recording))),(0,R.gn)(this,Pf,"f").element),',
    )
    .replace(
      replayViewEnd,
      'dispose(){window.__polytrackEndReplayWatch?.();(0,R.gn)(this,Bp,"f").removeChild((0,R.gn)(this,Gp,"f"))}',
    )
    .replace(personalBestRefreshAnchor, personalBestRefreshReplacement)
    .replace(leaderboardRootAnchor, leaderboardRootReplacement)
    .replace(iceServerCredentialsAnchor, iceServerCredentialsReplacement)
    .replace(hostIceCandidateAnchor, hostIceCandidateReplacement)
    .replace(singleInstanceGuard, "")
    .replace(singleInstanceGate, "c.determinismState")
    .replace(singleInstancePrompt, "")
    .replace(
      communityTrackMarker,
      `${communityTrackEntries},${shardmirTrackEntry}${communityTrackMarker}`,
    )
    .replace(starryTropicsRegistryEntry, starryTropisxRegistryEntry)
    .replace(
      finalExistingTrackPart,
      `${finalExistingTrackPart},e[e.BlockOuterCorner=188]="BlockOuterCorner",e[e.PlaneCorner=189]="PlaneCorner"`,
    )
    .replace(
      planeSlopeUpTrackPart,
      `${planeCornerTrackPart},${planeSlopeUpTrackPart}`,
    )
    .replace(
      blockSlopeVerticalBottomTrackPart,
      `${blockOuterCornerTrackPart},${blockSlopeVerticalBottomTrackPart}`,
    )
    .replace(
      savedRecordingLoad,
      "const d=re.A.deserialize(s.recording);if(d){if(s.replayBoostSettings)d.replayBoostSettings=s.replayBoostSettings;if(s.replayBoostTimeline)d.replayBoostTimeline=s.replayBoostTimeline;if(s.normalPhysicsConfirmed===true)d.normalPhysicsConfirmed=true}return null==d?null:{uploadId:o,time:h,recording:d}",
    )
    .replace(
      recordingCarMessage,
      "carRecording:s?.serialize()??null,replayBoostSettings:s?.replayBoostSettings??null",
    )
    // Each car has a message callback. Find its binary state before decoding,
    // so the callback does not deserialize every other car's state too.
    .replace(carStateConsumer, carStateConsumerReplacement)
    // Cap expensive high-DPI rasterization while preserving the game's render
    // scale setting and allowing users to opt out of device pixel density.
    .replace(devicePixelDensitySetting, cappedDevicePixelDensitySetting)
    .replace(
      callbackStart,
      "I.n_().then((()=>{t.loadedResource()})),window.__polytrackStartupReady=!1,t.addCompleteListener((()=>{queueMicrotask(()=>{if(!window.__polytrackStartupReady)return;if(E.cleanUpRecords(),I.R_(),Pt.EM){",
    )
    .replace(callbackEnd, "q(e)}}});}));const a=i(7780);")
    .replace(
      profileStoreInitialization,
      `const E=new rd(e,w,S,x);(${installPolytrackPbBridge.toString()})(window,x,E,"polytrack_v5_"+(Pt.EM?"dev":Pt.Tn?"beta":"prod")+"_");window.__polytrackStartupReady=!0;const T=new ne`,
    );
}

export function patchPolytrackProfileSettingsBundle(source) {
  if (
    source.split(profileNicknameSaveAnchor).length - 1 !== 1 ||
    source.split(profileNicknameInputAnchor).length - 1 !== 1 ||
    source.split(profileNicknameInputLimit).length - 1 !== 1
  ) {
    throw new Error("PolyTrack profile name patch target was not found uniquely");
  }

  return source
    .replace(
      profileNicknameSaveAnchor,
      '(0,i.gn)(this,se,"f")&&((0,i.gn)(this,ne,"f").nickname!=(0,i.gn)(this,ee,"f")&&window.__polytrackProfileNicknameSaved?.((0,i.gn)(this,ne,"f").token,(0,i.gn)(this,ee,"f")),(0,i.gn)(this,Hn,"f").setNickname((0,i.gn)(this,ee,"f"))',
    )
    .replace(
      profileNicknameInputAnchor,
      '(0,i.gn)(this,j,"f").type="text",(0,i.gn)(this,j,"f").maxLength=32,(0,i.gn)(this,j,"f").placeholder=E.A.defaultNickname',
    )
    .replace(
      profileNicknameInputLimit,
      'for(;t.length>32;)t=Array.from(t).slice(0,-1).join("")',
    );
}