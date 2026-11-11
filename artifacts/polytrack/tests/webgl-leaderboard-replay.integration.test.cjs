/*
 * This is intentionally opt-in.  The ordinary workspace preview does not
 * expose WebGL and cannot exercise the WASM vehicle simulation.
 *
 * Run against an already served PolyTrack/API pair with:
 *
 *   POLYTRACK_WEBGL_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=http://127.0.0.1:80 \
 *   node --test artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Run the multiplayer browser regression by itself with:
 *
 *   POLYTRACK_MULTIPLAYER_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=http://127.0.0.1:80 \
 *   node --test artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Run the separate TURN-only check (direct ICE candidates are disabled) with:
 *
 *   POLYTRACK_MULTIPLAYER_RELAY_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=http://127.0.0.1:80 \
 *   node --test artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Run the separate-API-instance invite-delivery check with:
 *
 *   POLYTRACK_MULTIPLAYER_CROSS_INSTANCE_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=http://127.0.0.1:80 \
 *   node --test artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Run the Track of the Week outage regression by itself with:
 *
 *   POLYTRACK_WEEKLY_OUTAGE_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=http://127.0.0.1:80 \
 *   node --test artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Run the live Cloudflare replay smoke test only after explicit user approval.
 * It writes a temporary record on a unique, random track ID and deletes it in
 * test cleanup:
 *
 *   POLYTRACK_CLOUDFLARE_INTEGRATION=1 \
 *   POLYTRACK_BROWSER_URL=https://your-project.pages.dev \
 *   node --test --test-name-pattern="boosted WebGL leaderboard replay finishes" \
 *     artifacts/polytrack/tests/webgl-leaderboard-replay.integration.test.cjs
 *
 * Chromium is launched with SwiftShader.  No recording, finish frame, or
 * checkpoint is manufactured by this test: a run which does not finish is a
 * failed integration run with an actionable error.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { createServer: createHttpServer } = require("node:http");
const { createServer } = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  findRegisteredTracksUsingPartIds,
  loadBundleModules,
  parseTrack,
} = require("./community-track-test-utils.cjs");

const enabled = process.env.POLYTRACK_WEBGL_INTEGRATION === "1";
const cloudflareReplayEnabled =
  process.env.POLYTRACK_CLOUDFLARE_INTEGRATION === "1";
const multiplayerEnabled =
  process.env.POLYTRACK_MULTIPLAYER_INTEGRATION === "1";
const multiplayerRelayEnabled =
  process.env.POLYTRACK_MULTIPLAYER_RELAY_INTEGRATION === "1";
const crossInstanceMultiplayerEnabled =
  process.env.POLYTRACK_MULTIPLAYER_CROSS_INSTANCE_INTEGRATION === "1";
const weeklyOutageEnabled =
  process.env.POLYTRACK_WEEKLY_OUTAGE_INTEGRATION === "1";
const browserUrl = process.env.POLYTRACK_BROWSER_URL || "http://127.0.0.1:80";
if (cloudflareReplayEnabled && !browserUrl.startsWith("https://")) {
  throw new Error("The live Cloudflare replay check requires an HTTPS browser URL");
}
const chromium = process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium";
const timeoutMs = Number(process.env.POLYTRACK_WEBGL_TIMEOUT_MS || 120_000);
const crossInstancePlayerNickname = "Cross-instance privacy runner";
const boostValues = {
  accelerationMultiplier: process.env.POLYTRACK_TEST_ACCELERATION || "1.5",
  topSpeedMultiplier: process.env.POLYTRACK_TEST_TOP_SPEED || "1.2",
  brakingMultiplier: process.env.POLYTRACK_TEST_BRAKING || "1",
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const call = async (method, params = {}) => {
    await ready;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.text || "Browser evaluation failed");
    }
    return response.result.result.value;
  };
  return { call, evaluate, close: () => socket.close() };
}

async function openTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
      });
      return (await response.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chromium remote debugging endpoint did not start");
}

async function launchProfile(profileDirectory) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const process = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--disable-gpu-sandbox",
    "--window-size=1280,720",
    "about:blank",
  ], { stdio: "ignore" });
  const client = cdpClient(await openTarget(port));
  return {
    process,
    client,
    async close() {
      client.close();
      if (process.exitCode !== null || process.signalCode !== null) return;
      process.kill("SIGKILL");
      await new Promise((resolve) => process.once("exit", resolve));
    },
  };
}

function createMultiplayerServerOverride(apiServerUrl, joinerNickname = null) {
  return `(() => {
  const NativeWebSocket = window.WebSocket;
  const apiServer = new URL(${JSON.stringify(apiServerUrl)});
  const joinerNickname = ${JSON.stringify(joinerNickname)};
  window.__crossInstanceSocketRoutes = [];
  class RoutedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      const target = new URL(String(url), window.location.href);
      const isMultiplayerSocket =
        target.pathname.endsWith("/multiplayer/host") ||
        target.pathname.endsWith("/multiplayer/join");
      if (target.pathname.includes("/multiplayer/")) {
        window.__crossInstanceSocketRoutes.push({
          role: target.pathname.endsWith("/host")
            ? "host"
            : target.pathname.endsWith("/join")
              ? "join"
              : "other",
          redirected: isMultiplayerSocket,
        });
      }
      if (isMultiplayerSocket) {
        target.protocol = apiServer.protocol === "https:" ? "wss:" : "ws:";
        target.host = apiServer.host;
      }
      super(target.href, protocols);
      this.__crossInstanceNickname =
        joinerNickname && target.pathname === "/api/v6/multiplayer/join"
          ? joinerNickname
          : null;
    }
    send(data) {
      if (this.__crossInstanceNickname && typeof data === "string") {
        try {
          const message = JSON.parse(data);
          if (
            typeof message.inviteCode === "string" &&
            typeof message.offer === "string"
          ) {
            data = JSON.stringify({
              ...message,
              nickname: this.__crossInstanceNickname,
            });
          }
        } catch {}
      }
      return super.send(data);
    }
  }
  window.WebSocket = RoutedWebSocket;
})()`;
}

async function reserveLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createReplayTestApi() {
  const records = new Map();
  const leaderboardRequests = [];
  const forcedEmptyBoostStatuses = new Set();
  let nextId = 1;
  const server = createHttpServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    const sendJson = (body) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method === "POST" && url.pathname === "/api/v6/leaderboard") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const token = form.get("userToken") || "";
      const trackId = form.get("trackId") || "";
      const userId = createHash("sha256").update(token).digest("hex");
      let record = [...records.values()].find(
        (item) => item.trackId === trackId && item.userId === userId,
      );
      if (!record) record = { id: nextId++, trackId, userId };
      const parseJson = (key) => {
        const value = form.get(key);
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      };
      Object.assign(record, {
        nickname: form.get("nickname"),
        carStyle: form.get("carStyle"),
        frames: Number(form.get("frames")),
        recording: form.get("recording"),
        replayBoostSettings: parseJson("replayBoostSettings"),
        replayBoostTimeline: parseJson("replayBoostTimeline"),
        normalPhysicsConfirmed: form.get("normalPhysicsConfirmed") === "true",
      });
      records.set(record.id, record);
      sendJson({ uploadId: record.id, previousPosition: 0, newPosition: 1 });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v6/recordings") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",").map(Number).filter(Number.isSafeInteger);
      sendJson(ids.flatMap((id) => {
        const record = records.get(id);
        if (!record) return [];
        return [{
          id: record.id,
          trackId: record.trackId,
          userId: record.userId,
          nickname: record.nickname,
          carStyle: record.carStyle,
          frames: record.frames,
          verifiedState: 0,
          recording: record.recording,
          ...(record.replayBoostSettings
            ? { replayBoostSettings: record.replayBoostSettings } : {}),
          ...(record.replayBoostTimeline
            ? { replayBoostTimeline: record.replayBoostTimeline } : {}),
          ...(record.normalPhysicsConfirmed
            ? { normalPhysicsConfirmed: true } : {}),
        }];
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v6/leaderboard") {
      const requestedBoostStatus = url.searchParams.get("replayBoostStatus");
      const skip = Number(url.searchParams.get("skip") || 0);
      const amount = Number(url.searchParams.get("amount") || 20);
      leaderboardRequests.push({
        replayBoostStatus: requestedBoostStatus,
        skip,
        amount,
      });
      const leaderboardRecords = [...records.values()]
        .filter((record) => record.trackId === url.searchParams.get("trackId"))
        .sort((left, right) => left.frames - right.frames)
        .map((record) => {
          const replayBoostStatus =
            record.replayBoostSettings || record.replayBoostTimeline
              ? "boosted"
              : record.normalPhysicsConfirmed
                ? "not-boosted"
                : "unknown";
          return {
          id: record.id,
          userId: record.userId,
          nickname: record.nickname,
          countryCode: null,
          frames: record.frames,
          carStyle: record.carStyle,
          verifiedState: 0,
          replayBoostStatus,
          };
        });
      const forcedEmptyKey =
        `${url.searchParams.get("trackId")}:${requestedBoostStatus}`;
      const matchingRecords = forcedEmptyBoostStatuses.has(forcedEmptyKey)
        ? []
        : requestedBoostStatus && requestedBoostStatus !== "all"
          ? leaderboardRecords.filter(
            (record) => record.replayBoostStatus === requestedBoostStatus,
          )
          : leaderboardRecords;
      sendJson({
        total: matchingRecords.length,
        entries: matchingRecords.slice(skip, skip + amount),
        userEntry: null,
      });
      return;
    }

    if (request.method === "GET" &&
        url.pathname === "/api/v6/leaderboardUserEntry") {
      sendJson(null);
      return;
    }

    if (request.method === "POST" &&
        url.pathname === "/api/v6/leaderboardNickname") {
      sendJson({ updatedRecords: 0 });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    getLeaderboardRequests: () => leaderboardRequests.map((request) => ({ ...request })),
    setBoostStatusEmpty: (trackId, status, empty) => {
      const key = `${trackId}:${status}`;
      if (empty) forcedEmptyBoostStatuses.add(key);
      else forcedEmptyBoostStatuses.delete(key);
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function launchApiInstance() {
  const port = await reserveLocalPort();
  const apiEntry = path.resolve(__dirname, "../../api-server/dist/index.mjs");
  const child = spawn(process.execPath, [apiEntry], {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("A cross-instance API server exited before becoming ready");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error("A cross-instance API server did not become ready");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    logs: () => output,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
      await exited;
      clearTimeout(killTimer);
    },
  };
}

function summarizeMultiplayerApiLogs(apiInstance) {
  return apiInstance.logs().split(/\r?\n/).flatMap((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    if (typeof record.msg !== "string" || !record.msg.includes("Multiplayer")) {
      return [];
    }
    const summary = {};
    for (const key of ["msg", "role", "messageKind", "outcome", "reason", "delivery"]) {
      if (typeof record[key] === "string") summary[key] = record[key];
    }
    return [summary];
  });
}

function createRelayOnlyProbe() {
  return `(() => {
  const NativePeerConnection = window.RTCPeerConnection;
  if (!NativePeerConnection) throw new Error("WebRTC is unavailable");
  const connections = [];
  const configuredRelayTransports = new Set();
  let dataChannelAttempts = 0;
  let candidateErrorEventCount = 0;
  const candidateTypes = new Set();
  const candidateErrorCodes = new Set();
  const getRelayTransport = (url) => {
    if (typeof url !== "string") return null;
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    const transport = new URLSearchParams(url.split("?")[1] ?? "")
      .get("transport")
      ?.toLowerCase();
    if (scheme === "turns:" && transport !== "udp") return "tls";
    if (scheme === "turn:" && transport === "tcp") return "tcp";
    return null;
  };
  const trackDataChannel = (connection, channel) => {
    if (connection.dataChannels.includes(channel)) return;
    connection.dataChannels.push(channel);
  };
  window.RTCPeerConnection = class RelayOnlyPeerConnection extends NativePeerConnection {
    constructor(configuration = {}, ...args) {
      const iceServers = (configuration.iceServers ?? []).flatMap((server) => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
          .filter((url) => getRelayTransport(url) !== null);
        for (const url of urls) {
          configuredRelayTransports.add(getRelayTransport(url));
        }
        return urls.length > 0 ? [{ ...server, urls }] : [];
      });
      if (iceServers.length === 0) {
        throw new Error("No TCP/TLS TURN endpoints were provided to WebRTC");
      }
      super({ ...configuration, iceServers, iceTransportPolicy: "relay" }, ...args);
      this.dataChannels = [];
      connections.push(this);
      this.addEventListener("icecandidate", (event) => {
        if (event.candidate?.type) candidateTypes.add(event.candidate.type);
      });
      this.addEventListener("icecandidateerror", (event) => {
        candidateErrorEventCount += 1;
        if (Number.isSafeInteger(event.errorCode)) {
          candidateErrorCodes.add(event.errorCode);
        }
      });
      const createDataChannel = this.createDataChannel.bind(this);
      this.createDataChannel = (...channelArgs) => {
        dataChannelAttempts += 1;
        const channel = createDataChannel(...channelArgs);
        trackDataChannel(this, channel);
        return channel;
      };
      this.addEventListener("datachannel", (event) => {
        trackDataChannel(this, event.channel);
      });
    }
  };
  window.__polytrackRelayPeerConnections = connections;
  window.__polytrackRelayProbeStatus = () => ({
    patched: window.RTCPeerConnection.name === "RelayOnlyPeerConnection",
    dataChannelAttempts,
    candidateErrorEventCount,
    candidateTypes: [...candidateTypes],
    candidateErrorCodes: [...candidateErrorCodes],
    configuredRelayTransports: [...configuredRelayTransports].sort(),
  });
})()`;
}

function createRelaySnapshotExpression() {
  return `(async () => {
    const connections = window.__polytrackRelayPeerConnections ?? [];
    return Promise.all(connections.map(async (connection) => {
      const reports = await connection.getStats();
      const reportList = [...reports.values()];
      const selectedPair = reportList.find((report) =>
        report.type === "candidate-pair" &&
        (report.selected === true ||
          (report.nominated === true && report.state === "succeeded")));
      const local = selectedPair && reportList.find((report) =>
        report.id === selectedPair.localCandidateId);
      const remote = selectedPair && reportList.find((report) =>
        report.id === selectedPair.remoteCandidateId);
      return {
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        signalingState: connection.signalingState,
        iceGatheringState: connection.iceGatheringState,
        iceTransportPolicy: connection.getConfiguration()?.iceTransportPolicy ?? null,
        localDescriptionType: connection.localDescription?.type ?? null,
        remoteDescriptionType: connection.remoteDescription?.type ?? null,
        localCandidateTypes: reportList
          .filter((report) => report.type === "local-candidate")
          .map((report) => report.candidateType)
          .filter(Boolean),
        selectedPair: selectedPair ? {
          state: selectedPair.state,
          localCandidateType: local?.candidateType ?? null,
          remoteCandidateType: remote?.candidateType ?? null,
          localRelayProtocol: local?.relayProtocol ?? null,
          remoteRelayProtocol: remote?.relayProtocol ?? null,
        } : null,
        openDataChannels: connection.dataChannels.filter(
          (channel) => channel.readyState === "open",
        ).length,
        dataChannelCount: connection.dataChannels.length,
        transceiverCount: connection.getTransceivers().length,
      };
    }));
  })()`;
}

async function waitForRelayDataChannel(hostClient, joinClient) {
  const end = Date.now() + timeoutMs;
  let latest = { host: [], joiner: [] };
  while (Date.now() < end) {
    [latest.host, latest.joiner] = await Promise.all([
      hostClient.evaluate(createRelaySnapshotExpression()),
      joinClient.evaluate(createRelaySnapshotExpression()),
    ]);
    const hasRelayDataChannel = (connections) => connections.some((connection) =>
      connection.iceConnectionState === "connected" ||
      connection.iceConnectionState === "completed"
        ? connection.selectedPair?.state === "succeeded" &&
          connection.iceTransportPolicy === "relay" &&
          connection.selectedPair.localCandidateType === "relay" &&
          connection.selectedPair.remoteCandidateType === "relay" &&
          ["tcp", "tls"].includes(connection.selectedPair.localRelayProtocol) &&
          ["tcp", "tls"].includes(connection.selectedPair.remoteRelayProtocol) &&
          connection.openDataChannels > 0
        : false,
    );
    if (hasRelayDataChannel(latest.host) && hasRelayDataChannel(latest.joiner)) {
      return latest;
    }
    await sleep(250);
  }
  const [hostProbe, joinProbe] = await Promise.all([
    hostClient.evaluate("window.__polytrackRelayProbeStatus?.() ?? null"),
    joinClient.evaluate("window.__polytrackRelayProbeStatus?.() ?? null"),
  ]);
  throw new Error(
    "Relay-only multiplayer did not open a data channel on a selected relay pair " +
      `for both browsers; candidate-check details: ${JSON.stringify({
        hostProbe,
        joinProbe,
        connections: latest,
      })}`,
  );
}

function createWorkerProbe(
  trackFixture,
  testTrackId,
  fixturePathname = "/main/tracks/community/90_reset.track",
  apiServerUrl = null,
) {
  return `(() => {
  const fixtureTrack = ${JSON.stringify(trackFixture)};
  const fixtureTrackId = ${JSON.stringify(testTrackId)};
  const fixturePathname = ${JSON.stringify(fixturePathname)};
  const apiServerUrl = ${JSON.stringify(apiServerUrl)};
  const rewriteLeaderboardUrl = (value) => {
    const url = new URL(value, window.location.href);
    if (url.pathname.includes("/api/v6/leaderboard") &&
        url.searchParams.has("trackId")) {
      url.searchParams.set("trackId", fixtureTrackId);
    }
    if (apiServerUrl && [
      "/api/v6/leaderboard",
      "/api/v6/leaderboardUserEntry",
      "/api/v6/leaderboardNickname",
      "/api/v6/recordings",
    ].includes(url.pathname)) {
      const api = new URL(apiServerUrl);
      url.protocol = api.protocol;
      url.host = api.host;
    }
    return url;
  };
  const nativeFetch = window.fetch.bind(window);
  window.__polytrackFixtureLoads = 0;
  window.fetch = (input, ...args) => {
    const requestUrl = typeof input === "string" ? input : input?.url ?? String(input);
    const parsedUrl = requestUrl
      ? rewriteLeaderboardUrl(requestUrl)
      : null;
    if (parsedUrl?.pathname.endsWith(fixturePathname)) {
      window.__polytrackFixtureLoads += 1;
      return Promise.resolve(new Response(fixtureTrack, {
        status: 200, headers: { "Content-Type": "text/plain" },
      }));
    }
    if (parsedUrl && parsedUrl.href !== new URL(requestUrl, window.location.href).href) {
      const forwardedInput = input instanceof Request
        ? new Request(parsedUrl.href, input) : parsedUrl.href;
      return nativeFetch(forwardedInput, ...args);
    }
    return nativeFetch(input, ...args);
  };
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends NativeXMLHttpRequest {
    constructor(...args) {
      super(...args);
      this.__polytrackFixtureRequest = false;
      this.__polytrackFixtureReadyState = 0;
    }
    open(method, url, ...args) {
      const requestUrl = rewriteLeaderboardUrl(String(url));
      this.__polytrackFixtureRequest = requestUrl.pathname.endsWith(fixturePathname);
      if (this.__polytrackFixtureRequest) {
        window.__polytrackFixtureLoads += 1;
        this.__polytrackFixtureReadyState = 1;
        return;
      }
      return super.open(method, requestUrl.href, ...args);
    }
    overrideMimeType(mimeType) {
      if (this.__polytrackFixtureRequest) return;
      return super.overrideMimeType(mimeType);
    }
    send(...args) {
      if (!this.__polytrackFixtureRequest) return super.send(...args);
      queueMicrotask(() => {
        this.__polytrackFixtureReadyState = 4;
        this.dispatchEvent(new Event("readystatechange"));
      });
    }
    get readyState() {
      return this.__polytrackFixtureRequest
        ? this.__polytrackFixtureReadyState : super.readyState;
    }
    get status() {
      return this.__polytrackFixtureRequest ? 200 : super.status;
    }
    get responseText() {
      return this.__polytrackFixtureRequest ? fixtureTrack : super.responseText;
    }
    get response() {
      return this.__polytrackFixtureRequest ? fixtureTrack : super.response;
    }
  };
  window.__polytrackWebglStates = [];
  window.__polytrackKeyEvents = [];
  window.__polytrackFailedTrackErrors = [];
  const trackErrorObserver = new MutationObserver(() => {
    if (document.body?.innerText.includes("Failed to load track")) {
      window.__polytrackFailedTrackErrors.push(Date.now());
    }
  });
  trackErrorObserver.observe(document, {
    subtree: true, childList: true, characterData: true,
  });
  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, (event) => {
      if (/^(Arrow|Key|Escape)/.test(event.code)) {
        window.__polytrackKeyEvents.push({ type, key: event.key, code: event.code });
      }
    });
  }
  window.__polytrackLocalCarId = null;
  window.__polytrackReplayCarIds = [];
  window.__polytrackReplayLoadingFrames = [];
  window.__polytrackBoostFrameBatches = [];
  window.__polytrackRecordWrites = [];
  const nativeStorageSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (typeof key === "string" &&
        /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key)) {
      let record;
      try { record = JSON.parse(String(value)); } catch {}
      window.__polytrackRecordWrites.push({
        recording: record?.recording ?? null,
        frames: record?.frames ?? null,
        hasSettings: Boolean(record?.replayBoostSettings),
        hasTimeline: Boolean(record?.replayBoostTimeline),
        pendingSettings: window.__polytrackPendingReplayBoostSettings ?? null,
        pendingTimeline: window.__polytrackPendingReplayBoostTimeline ?? null,
      });
    }
    return nativeStorageSetItem.call(this, key, value);
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", ({ data }) => {
        if (Array.isArray(data?.__polytrackBoostFrames)) {
          window.__polytrackBoostFrameBatches.push(...data.__polytrackBoostFrames);
        }
        if (data?.messageType !== 10 || !Array.isArray(data.carStateBuffers)) return;
        for (const buffer of data.carStateBuffers) {
          const view = new DataView(buffer);
          const flags = view.getUint8(11);
          const frame = view.getUint8(4) | (view.getUint8(5) << 8) |
            (view.getUint8(6) << 16);
          const carId = view.getUint32(0, true);
          if (carId !== window.__polytrackLocalCarId &&
              !window.__polytrackReplayCarIds.includes(carId)) continue;
          if (window.__polytrackReplayCarIds.includes(carId)) {
            window.__polytrackReplayLoadingFrames.push(frame);
          }
          const checkpointOffset = (flags & 2) ? 15 : 12;
          const positionOffset = (flags & 2) ? 17 : 14;
          const state = {
            carId,
            frame,
            speed: view.getFloat32(7, true),
            checkpoint: view.getUint16(checkpointOffset, true),
            position: [
              view.getFloat32(positionOffset, true),
              view.getFloat32(positionOffset + 4, true),
              view.getFloat32(positionOffset + 8, true),
            ],
            finishFrame: (flags & 2)
              ? view.getUint8(12) | (view.getUint8(13) << 8) |
                (view.getUint8(14) << 16)
              : null,
          };
          window.__polytrackWebglStates.push(state);
        }
      });
      const nativePostMessage = this.postMessage.bind(this);
      this.postMessage = (message, ...rest) => {
        if (message?.messageType === 3) {
          if (message.carRecording == null) {
            window.__polytrackLocalCarId = message.carId;
          } else if (!window.__polytrackReplayCarIds.includes(message.carId)) {
            window.__polytrackReplayCarIds.push(message.carId);
          }
        }
        return nativePostMessage(message, ...rest);
      };
    }
  };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
  window.__polytrackWebglAvailable = Boolean(context);
})()`;
}

function createWeeklyApiOutageProbe(successPayload) {
  const serializedPayload = JSON.stringify(successPayload);
  return `(() => {
  const nativeFetch = window.fetch.bind(window);
  const successfulPayload = ${JSON.stringify(serializedPayload)};
  window.__polytrackWeeklyRequestCount = 0;
  window.fetch = (input, ...args) => {
    const requestUrl = typeof input === "string"
      ? input
      : input?.url ?? String(input);
    const parsedUrl = new URL(requestUrl, window.location.href);
    if (parsedUrl.pathname !== "/api/v6/trackOfTheWeek") {
      return nativeFetch(input, ...args);
    }
    window.__polytrackWeeklyRequestCount += 1;
    if (window.__polytrackWeeklyRequestCount === 1) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: "Weekly map service unavailable" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response(successfulPayload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
})()`;
}

function createWeeklyApiBodyStallProbe(successPayload) {
  const serializedPayload = JSON.stringify(successPayload);
  return `(() => {
  const nativeFetch = window.fetch.bind(window);
  const successfulPayload = ${JSON.stringify(serializedPayload)};
  window.__polytrackWeeklyRequestCount = 0;
  window.__polytrackWeeklyRequestAborted = false;
  window.__polytrackWeeklyHeadersReceived = false;
  window.__polytrackWeeklyResponseStatus = null;
  window.__polytrackWeeklyJsonCallCount = 0;
  window.fetch = (input, ...args) => {
    const requestUrl = typeof input === "string"
      ? input
      : input?.url ?? String(input);
    const parsedUrl = new URL(requestUrl, window.location.href);
    if (parsedUrl.pathname !== "/api/v6/trackOfTheWeek") {
      return nativeFetch(input, ...args);
    }
    window.__polytrackWeeklyRequestCount += 1;
    if (window.__polytrackWeeklyRequestCount === 1) {
      const signal = args[0]?.signal;
      signal?.addEventListener("abort", () => {
        window.__polytrackWeeklyRequestAborted = true;
      }, { once: true });
      const response = new Response(successfulPayload, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      window.__polytrackWeeklyHeadersReceived = true;
      window.__polytrackWeeklyResponseStatus = response.status;
      response.json = () => {
        window.__polytrackWeeklyJsonCallCount += 1;
        return new Promise(() => {});
      };
      return Promise.resolve(response);
    }
    return Promise.resolve(new Response(successfulPayload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
})()`;
}

function createWeeklyRolloverProbe(initialPayload, nextPayload) {
  const serializedPayloads = JSON.stringify([initialPayload, nextPayload]);
  return `(() => {
  const NativeDate = window.Date;
  let clockOffset = 0;
  const getCurrentTime = () => NativeDate.now() + clockOffset;
  function TestDate(...args) {
    if (!new.target) return new NativeDate(getCurrentTime()).toString();
    return args.length === 0
      ? new NativeDate(getCurrentTime())
      : new NativeDate(...args);
  }
  TestDate.prototype = NativeDate.prototype;
  Object.setPrototypeOf(TestDate, NativeDate);
  TestDate.now = getCurrentTime;
  window.Date = TestDate;
  window.__polytrackSetTestTime = (time) => {
    clockOffset = Number(time) - NativeDate.now();
  };
  window.__polytrackWeeklyDocumentToken =
    crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

  const nativeFetch = window.fetch.bind(window);
  const weeklyPayloads = ${JSON.stringify(serializedPayloads)};
  const responses = JSON.parse(weeklyPayloads);
  window.__polytrackWeeklyRequestCount = 0;
  window.__polytrackWeeklyLeaderboardRequests = [];
  window.fetch = (input, ...args) => {
    const requestUrl = typeof input === "string"
      ? input
      : input?.url ?? String(input);
    const parsedUrl = new URL(requestUrl, window.location.href);
    if (parsedUrl.pathname === "/api/v6/leaderboard") {
      const trackId = parsedUrl.searchParams.get("trackId");
      window.__polytrackWeeklyLeaderboardRequests.push({
        trackId,
        onlyVerified: parsedUrl.searchParams.get("onlyVerified"),
        amount: parsedUrl.searchParams.get("amount"),
      });
      const requestNumber = window.__polytrackWeeklyLeaderboardRequests.length;
      return Promise.resolve(new Response(JSON.stringify({
        total: 1,
        entries: [{
          nickname: "Weekly driver " +
            (trackId?.slice(0, 8) ?? "unknown") +
            " #" + requestNumber,
          frames: 900,
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    if (parsedUrl.pathname !== "/api/v6/trackOfTheWeek") {
      return nativeFetch(input, ...args);
    }
    const responseIndex = window.__polytrackWeeklyRequestCount;
    window.__polytrackWeeklyRequestCount += 1;
    const payload = responses[Math.min(responseIndex, responses.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
})()`;
}

function createTrackDriveProbe() {
  return `(() => {
  window.__polytrackWebglStates = [];
  window.__polytrackWorkerErrors = [];
  window.__polytrackWorkerMessages = [];
  window.__polytrackObservedWorkers = [];
  window.__polytrackPageErrors = [];
  window.__polytrackFailedTrackErrors = [];
  window.__polytrackLocalCarId = null;
  window.addEventListener("error", (event) => {
    window.__polytrackPageErrors.push(event.message || "Page error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    window.__polytrackPageErrors.push(String(event.reason || "Unhandled rejection"));
  });
  const observer = new MutationObserver(() => {
    if (document.body?.innerText.includes("Failed to load track")) {
      window.__polytrackFailedTrackErrors.push(Date.now());
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });

  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      window.__polytrackObservedWorkers.push(String(args[0]));
      this.addEventListener("error", (event) => {
        window.__polytrackWorkerErrors.push({
          type: "error",
          message: event.message || event.error?.message || "Worker error",
          filename: event.filename || "",
        });
      });
      this.addEventListener("messageerror", () => {
        window.__polytrackWorkerErrors.push({
          type: "messageerror",
          message: "Worker message could not be deserialized",
        });
      });
      this.addEventListener("message", ({ data }) => {
        window.__polytrackWorkerMessages.push({
          type: data?.messageType ?? null,
          keys: data && typeof data === "object" ? Object.keys(data) : [],
          stateCount: Array.isArray(data?.carStateBuffers)
            ? data.carStateBuffers.length : null,
        });
        if (window.__polytrackWorkerMessages.length > 50) {
          window.__polytrackWorkerMessages.shift();
        }
        if (data?.messageType !== 10 || !Array.isArray(data.carStateBuffers)) return;
        for (const buffer of data.carStateBuffers) {
          const view = new DataView(buffer);
          const carId = view.getUint32(0, true);
          if (carId !== window.__polytrackLocalCarId) continue;
          const flags = view.getUint8(11);
          const positionOffset = (flags & 2) ? 17 : 14;
          window.__polytrackWebglStates.push({
            carId,
            frame: view.getUint8(4) | view.getUint8(5) << 8 |
              view.getUint8(6) << 16,
            speed: view.getFloat32(7, true),
            position: [
              view.getFloat32(positionOffset, true),
              view.getFloat32(positionOffset + 4, true),
              view.getFloat32(positionOffset + 8, true),
            ],
          });
        }
      });
      const nativePostMessage = this.postMessage.bind(this);
      this.postMessage = (message, ...rest) => {
        if (message?.messageType === 3 && message.carRecording == null) {
          window.__polytrackLocalCarId = message.carId;
        }
        return nativePostMessage(message, ...rest);
      };
    }
  };

  const canvas = document.createElement("canvas");
  window.__polytrackWebglAvailable = Boolean(
    canvas.getContext("webgl2") || canvas.getContext("webgl"),
  );
})()`;
}

async function waitFor(client, expression, label, waitTimeoutMs = timeoutMs) {
  const end = Date.now() + waitTimeoutMs;
  while (Date.now() < end) {
    if (await client.evaluate(expression)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function assertPhoneLeaderboardLayout(client) {
  const layouts = [];
  for (const width of [360, 390, 430]) {
    await client.call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const rows = await client.evaluate(`(() => {
      const overlaps = (a, b) =>
        a.left < b.right && a.right > b.left &&
        a.top < b.bottom && a.bottom > b.top;
      return [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main",
      )].map((row) => {
        const name = row.querySelector(".right .name");
        const time = row.querySelector(".left > p:not(.position)");
        const status = row.querySelector(".polytrack-boost-status");
        const rowRect = row.getBoundingClientRect();
        const nameRect = name?.getBoundingClientRect();
        const timeRect = time?.getBoundingClientRect();
        const statusRect = status?.getBoundingClientRect();
        return {
          label: status?.textContent.trim(),
          rowHeight: rowRect.height,
          rowCssHeight: Number.parseFloat(getComputedStyle(row).height),
          statusVisible: Boolean(statusRect?.width && statusRect?.height) &&
            getComputedStyle(status).display !== "none" &&
            getComputedStyle(status).visibility !== "hidden",
          statusInsideRow: Boolean(statusRect) &&
            statusRect.left >= rowRect.left &&
            statusRect.right <= rowRect.right &&
            statusRect.top >= rowRect.top &&
            statusRect.bottom <= rowRect.bottom,
          statusTextFits: Boolean(status) &&
            status.scrollWidth <= status.clientWidth,
          statusOverlapsName: Boolean(nameRect && statusRect) &&
            overlaps(nameRect, statusRect),
          statusOverlapsTime: Boolean(timeRect && statusRect) &&
            overlaps(timeRect, statusRect),
          nameVisible: Boolean(nameRect?.width && nameRect?.height),
          timeVisible: Boolean(timeRect?.width && timeRect?.height),
        };
      });
    })()`);
    assert.ok(rows.length > 0,
      `${width}px phone viewport had no leaderboard rows to inspect`);
    for (const row of rows) {
      assert.ok(row.rowCssHeight >= 124,
        `${width}px phone row did not make room for its replay status: ${JSON.stringify(row)}`);
      assert.equal(row.statusVisible, true,
        `${width}px phone replay label was not visible: ${JSON.stringify(row)}`);
      assert.equal(row.statusInsideRow, true,
        `${width}px phone replay label escaped its row: ${JSON.stringify(row)}`);
      assert.equal(row.statusTextFits, true,
        `${width}px phone replay label was clipped: ${JSON.stringify(row)}`);
      assert.equal(row.statusOverlapsName, false,
        `${width}px phone replay label crowded the player name: ${JSON.stringify(row)}`);
      assert.equal(row.statusOverlapsTime, false,
        `${width}px phone replay label crowded the race time: ${JSON.stringify(row)}`);
      assert.equal(row.nameVisible, true,
        `${width}px phone player name was not visible: ${JSON.stringify(row)}`);
      assert.equal(row.timeVisible, true,
        `${width}px phone race time was not visible: ${JSON.stringify(row)}`);
    }
    layouts.push({ width, labels: rows.map((row) => row.label) });
  }
  return layouts;
}

async function waitForReplayStatus(client, expression, label) {
  try {
    await waitFor(client, expression, label, 20_000);
  } catch (error) {
    const state = await client.evaluate(`(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      const replayIds = window.__polytrackReplayCarIds ?? [];
      const replayStates = (window.__polytrackWebglStates ?? [])
        .filter((item) => replayIds.includes(item.carId));
      return {
        statusExists: Boolean(status),
        statusHidden: status?.hidden ?? null,
        statusText: status?.textContent ?? null,
        menuHidden: document.getElementById("polytrack-cheat-backdrop")?.hidden ?? null,
        menuAvailable: window.__polytrackCheatUnlocked ?? null,
        replayIds,
        replayStateCount: replayStates.length,
        lastReplayFrame: replayStates.at(-1)?.frame ?? null,
        bodyText: document.body?.innerText.slice(0, 1000) ?? "",
      };
    })()`);
    throw new Error(`${error.message}; replay UI state: ${JSON.stringify(state)}`);
  }
}

async function clickVisibleButton(client, selector, text) {
  return client.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => item.innerText.trim() === ${JSON.stringify(text)} &&
        !item.disabled && item.offsetWidth > 0 && item.offsetHeight > 0);
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function openMultiplayerScreen(client, profileLabel) {
  await client.call("Page.navigate", { url: browserUrl });
  await waitFor(client, "window.__polytrackStartupReady === true", `${profileLabel} startup`);
  await waitFor(
    client,
    "!document.body?.innerText.includes('Loading...')",
    `${profileLabel} game resources`,
  );
  await waitFor(
    client,
    "document.querySelector('.main-buttons-container:not(.hidden)')",
    `${profileLabel} main menu`,
  );
  assert.equal(
    await client.evaluate(`(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    })()`),
    true,
    "SwiftShader Chromium did not provide WebGL",
  );
  assert.equal(
    await clickVisibleButton(client, "button", "Multiplayer"),
    true,
    `${profileLabel} could not open Multiplayer`,
  );
  await waitFor(
    client,
    "document.querySelector('.message-box-ui') || document.querySelector('.multiplayer-ui')",
    `${profileLabel} multiplayer entry`,
  );
  const continuePrompt = await clickVisibleButton(
    client,
    ".message-box-ui button",
    "Continue",
  );
  if (continuePrompt) {
    await waitFor(
      client,
      "document.querySelector('.multiplayer-ui')",
      `${profileLabel} multiplayer menu`,
    );
  }
  await waitFor(
    client,
    "document.querySelector('.multiplayer-ui')",
    `${profileLabel} multiplayer menu`,
  );
}

async function hostGameWithInvite(client) {
  await openMultiplayerScreen(client, "Host profile");
  assert.equal(
    await clickVisibleButton(client, ".multiplayer-ui .join button", "Host"),
    true,
    "Host option was unavailable",
  );
  await waitFor(
    client,
    "document.querySelector('.multiplayer-ui > .host:not(.hidden)')",
    "host setup screen",
  );
  assert.equal(
    await clickVisibleButton(
      client,
      ".multiplayer-ui > .host button.track-button",
      "Select Track",
    ),
    true,
    "host could not open track selection",
  );
  await waitFor(
    client,
    `[...document.querySelectorAll("button")].some((button) =>
      button.innerText.trim().startsWith("Summer 1") &&
      button.offsetWidth > 0 && button.offsetHeight > 0)`,
    "official track selection",
  );
  const selectedTrack = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.innerText.trim().startsWith("Summer 1") &&
      item.offsetWidth > 0 && item.offsetHeight > 0);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(selectedTrack, true, "host could not select an official track");
  await waitFor(
    client,
    `document.querySelector('.multiplayer-ui > .host .track-button')?.innerText
      .includes("Summer 1") &&
      [...document.querySelectorAll('.multiplayer-ui > .host button')]
        .some((button) => button.innerText.trim() === "Host" && !button.disabled)`,
    "selected host track",
  );
  assert.equal(
    await clickVisibleButton(client, ".multiplayer-ui > .host button", "Host"),
    true,
    "host could not start the selected track",
  );
  await waitFor(
    client,
    `document.querySelector('.game-ui button')?.innerText.trim() === "Exit" &&
      [...document.querySelectorAll('.game-ui button')]
        .some((button) => button.innerText.trim() === "Invite")`,
    "host game screen",
  );
  assert.equal(
    await clickVisibleButton(client, ".game-ui button", "Invite"),
    true,
    "host could not open the invite screen",
  );
  await waitFor(
    client,
    `document.querySelector('.invite-ui input[type="text"]')?.value.length === 4`,
    "host invite code",
  );
  const inviteCode = await client.evaluate(
    `document.querySelector('.invite-ui input[type="text"]')?.value ?? null`,
  );
  assert.equal(typeof inviteCode, "string", "host did not display an invite code");
  assert.equal(inviteCode.length, 4, "host displayed an invalid invite code");
  assert.ok(/^\d{4}$/.test(inviteCode), "host displayed an invalid invite code");
  return inviteCode;
}

async function joinWithInvite(client, inviteCode) {
  await openMultiplayerScreen(client, "Joining profile");
  await waitFor(
    client,
    `document.querySelector('.multiplayer-ui .join input.invite-code') &&
      document.querySelector('.multiplayer-ui .join button.join')`,
    "join form",
  );
  await client.evaluate(
    `document.querySelector('.multiplayer-ui .join input.invite-code')?.focus()`,
  );
  await client.call("Input.insertText", { text: inviteCode });
  await waitFor(
    client,
    `document.querySelector('.multiplayer-ui .join input.invite-code')?.value.length === 4 &&
      !document.querySelector('.multiplayer-ui .join button.join')?.disabled`,
    "entered invite",
  );
  assert.equal(
    await clickVisibleButton(client, ".multiplayer-ui .join button.join", "Join"),
    true,
    "joiner could not submit the invite",
  );
}

async function press(client, key, type) {
  await client.call("Input.dispatchKeyEvent", {
    type,
    key,
    code: key,
    windowsVirtualKeyCode: {
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, KeyR: 82,
      Escape: 27,
    }[key],
  });
}

async function pressSpace(client) {
  // Include the character event so headless Chromium emits the native button click.
  for (const type of ["keyDown", "char", "keyUp"]) {
    await client.call("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      text: " ",
      unmodifiedText: " ",
      windowsVirtualKeyCode: 32,
    });
  }
}

async function currentLocalFrame(client) {
  return client.evaluate(`(() => {
    const carId = window.__polytrackLocalCarId;
    const states = window.__polytrackWebglStates.filter((state) => state.carId === carId);
    return states.at(-1)?.frame ?? null;
  })()`);
}

async function waitForLogicalFrame(client, targetFrame) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const frame = await currentLocalFrame(client);
    if (frame !== null && frame >= targetFrame) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for simulation frame ${targetFrame}`);
}

async function startTrack(client, preferredTrack = "90*RESET") {
  await openTrack(client, preferredTrack);
  await startSelectedTrack(client, preferredTrack);
}

async function startSelectedTrack(client, expectedTrack = "90*RESET") {
  await waitFor(
    client,
    `document.querySelector(".track-info-ui")?.innerText.includes(${JSON.stringify(expectedTrack)}) &&
      [...document.querySelectorAll(".track-info-ui button")]
        .some((button) => button.innerText.trim() === "Play" && !button.disabled)`,
    `${expectedTrack} track details and Play control`,
  );
  const started = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(".track-info-ui button")]
      .find((item) => item.innerText.trim() === "Play" && !item.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(started, true, `the Play control for ${expectedTrack} was unavailable`);
  await sleep(1_000);
}

async function openTrack(client, preferredTrack = "90*RESET") {
  await client.call("Page.navigate", { url: browserUrl });
  await waitFor(client, "window.__polytrackStartupReady === true", "PolyTrack startup");
  await waitFor(
    client,
    "!document.body?.innerText.includes('Loading...')",
    "PolyTrack startup resources",
  );
  await client.evaluate("[...document.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Play')?.click()");
  await waitFor(client, "document.querySelector('.track')", "track picker");
  await selectTrackFromPicker(client, preferredTrack);
}

async function selectTrackFromPicker(client, preferredTrack) {
  const selected = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((item) => item.innerText.includes(${JSON.stringify(preferredTrack)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(selected, true, `track ${preferredTrack} was not found`);
  await sleep(1_000);
}

async function driveForMovingStates(
  client,
  trackName,
  entryNumber,
  frameCount = 30,
) {
  await waitFor(client, "window.__polytrackWebglAvailable === true", "WebGL context");
  await client.evaluate(`(() => {
    window.__polytrackLocalCarId = null;
    window.__polytrackWebglStates = [];
  })()`);
  await startSelectedTrack(client, trackName);
  await press(client, "ArrowUp", "keyDown");
  try {
    await waitFor(
      client,
      "window.__polytrackLocalCarId !== null && window.__polytrackWebglStates.some((state) => state.carId === window.__polytrackLocalCarId)",
      `${trackName} entry ${entryNumber} player state`,
    );
    const carId = await client.evaluate("window.__polytrackLocalCarId");
    const initialFrame = await currentLocalFrame(client);
    assert.ok(Number.isSafeInteger(initialFrame),
      `${trackName} entry ${entryNumber} did not start a logical frame`);
    await waitForLogicalFrame(client, initialFrame + frameCount);
  } catch (error) {
    const diagnostics = await client.evaluate(`(() => ({
      localCarId: window.__polytrackLocalCarId,
      states: window.__polytrackWebglStates,
      workerErrors: window.__polytrackWorkerErrors,
      workerMessages: window.__polytrackWorkerMessages.slice(-20),
      workers: window.__polytrackObservedWorkers,
      pageErrors: window.__polytrackPageErrors,
      failedTrackErrors: window.__polytrackFailedTrackErrors,
      pageText: document.body?.innerText.slice(0, 800),
    }))()`);
    if (process.env.POLYTRACK_FAILURE_SCREENSHOT) {
      const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.POLYTRACK_FAILURE_SCREENSHOT,
        Buffer.from(screenshot.result.data, "base64"));
    }
    throw new Error(`${error.message}; browser state: ${JSON.stringify(diagnostics)}`);
  } finally {
    await press(client, "ArrowUp", "keyUp");
  }
  const carId = await client.evaluate("window.__polytrackLocalCarId");

  const states = await client.evaluate(`window.__polytrackWebglStates
    .filter((state) => state.carId === ${JSON.stringify(carId)})`);
  assert.ok(states.length >= 2,
    `${trackName} entry ${entryNumber} emitted too few player states`);
  const firstPosition = states[0].position;
  const maxDisplacement = Math.max(...states.map((state) => Math.hypot(
    state.position[0] - firstPosition[0],
    state.position[1] - firstPosition[1],
    state.position[2] - firstPosition[2],
  )));
  if (!states.some((state) => Math.abs(state.speed) > 0.1) ||
      maxDisplacement <= 0.1) {
    if (process.env.POLYTRACK_FAILURE_SCREENSHOT) {
      const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.POLYTRACK_FAILURE_SCREENSHOT,
        Buffer.from(screenshot.result.data, "base64"));
    }
    assert.fail(
      `${trackName} entry ${entryNumber} did not move: ` +
        `${JSON.stringify({ first: states[0], last: states.at(-1), maxDisplacement })}`,
    );
  }
  await assertNoTrackLoadError(client, `${trackName} entry ${entryNumber}`);
  return states;
}

async function exitToTrackSelection(client, entryNumber) {
  const dismissedNamePrompt = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((item) => item.innerText.trim() === "Not now");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (dismissedNamePrompt) await sleep(250);

  const exitedFromResults = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((item) => item.innerText.trim() === "Exit");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!exitedFromResults) {
    await press(client, "Escape", "keyDown");
    await press(client, "Escape", "keyUp");
    await waitFor(
      client,
      `document.body?.innerText.includes("Are you sure you want to quit?") &&
        [...document.querySelectorAll("button")]
          .some((button) => button.innerText.trim() === "Confirm")`,
      `quit confirmation after Eldritch Estate entry ${entryNumber}`,
    );
    const confirmed = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) => item.innerText.trim() === "Confirm");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(confirmed, true,
      `the quit confirmation for Eldritch Estate entry ${entryNumber} was unavailable`);
  }

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const selectionVisible = await client.evaluate(
      `(() => {
        const text = document.body?.innerText ?? "";
        return text.includes("Official tracks") &&
          text.includes("Community tracks") &&
          text.includes("Custom tracks");
      })()`,
    );
    if (selectionVisible) return;

    // Some builds return to the title screen first; use its Play control to
    // continue through the actual track-selection UI without reloading.
    const openedSelection = await client.evaluate(`(() => {
      const play = [...document.querySelectorAll("button")]
        .find((button) => button.innerText.trim() === "Play");
      if (!play) return false;
      play.click();
      return true;
    })()`);
    if (openedSelection) {
      await waitFor(client, "document.querySelector('.track')", "track selection");
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out returning from Eldritch Estate entry ${entryNumber} to track selection`);
}

async function assertRecordUnchanged(client, key, expectedValue, expectedRecording, stage) {
  const actual = await client.evaluate(`localStorage.getItem(${JSON.stringify(key)})`);
  assert.equal(actual, expectedValue,
    `the seeded Eldritch Estate personal best changed ${stage}`);
  const recording = actual == null ? null : JSON.parse(actual).recording;
  assert.equal(recording, expectedRecording,
    `the seeded Eldritch Estate recording changed ${stage}`);
}

async function seedEldritchRecordFromCompletedRun(client, eldritchTrackId) {
  return client.evaluate(`(async () => {
    const fixtureRecordKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'));
    if (!fixtureRecordKey) throw new Error("completed fixture run was not saved");
    const fixtureRecord = JSON.parse(localStorage.getItem(fixtureRecordKey));
    if (!fixtureRecord || typeof fixtureRecord.recording !== "string") {
      throw new Error("completed fixture run has no serialized recording");
    }
    const profileKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_user_/.test(key));
    const profile = profileKey && JSON.parse(localStorage.getItem(profileKey));
    if (!profile?.token || !profile?.carStyle || !Number.isSafeInteger(fixtureRecord.frames)) {
      throw new Error("completed fixture run has no uploadable local profile or race time");
    }
    const form = new URLSearchParams({
      version: "v6",
      userToken: profile.token,
      nickname: profile.nickname,
      carStyle: profile.carStyle,
      trackId: ${JSON.stringify(eldritchTrackId)},
      frames: String(fixtureRecord.frames),
      recording: fixtureRecord.recording,
      onlyVerified: "true",
      replayBoostSettings: JSON.stringify(fixtureRecord.replayBoostSettings),
      replayBoostTimeline: JSON.stringify(fixtureRecord.replayBoostTimeline),
    });
    const response = await fetch("/api/v6/leaderboard", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error("could not register the seeded Eldritch Estate record: " +
        response.status);
    }
    const upload = await response.json();
    const uploadId = typeof upload === "number" ? upload : upload?.uploadId;
    if (!Number.isSafeInteger(uploadId)) {
      throw new Error("seeded Eldritch Estate record returned no upload ID");
    }
    fixtureRecord.uploadId = uploadId;
    const eldritchRecordKey = fixtureRecordKey.replace(
      /[a-f0-9]{64}$/,
      ${JSON.stringify(eldritchTrackId)},
    );
    if (eldritchRecordKey === fixtureRecordKey) {
      throw new Error("could not derive the Eldritch Estate personal-best key");
    }
    const seededValue = JSON.stringify(fixtureRecord);
    localStorage.setItem(eldritchRecordKey, seededValue);
    return {
      key: eldritchRecordKey,
      value: localStorage.getItem(eldritchRecordKey),
      recording: fixtureRecord.recording,
      frames: fixtureRecord.frames,
      uploadId,
    };
  })()`);
}

function assertNoTrackLoadError(client, entryNumber) {
  return client.evaluate(`(() => {
    const observed = window.__polytrackFailedTrackErrors ?? [];
    const text = document.body?.innerText ?? "";
    const visible = text.includes("Failed to load track");
    if (observed.length > 0 || visible) {
      throw new Error("Failed to load track during community-track entry " +
        ${JSON.stringify(entryNumber)});
    }
    if (text.includes("Oh no! PolyTrack encountered an unexpected error!")) {
      throw new Error("PolyTrack crashed during community-track entry " +
        ${JSON.stringify(entryNumber)});
    }
    return true;
  })()`);
}

async function assertNoWorkerError(client, trackName) {
  const errors = await client.evaluate(
    "window.__polytrackWorkerErrors ?? []",
  );
  assert.deepEqual(
    errors,
    [],
    `${trackName} reported worker errors: ${JSON.stringify(errors)}`,
  );
}

async function unlockCheatMenu(client) {
  await client.evaluate(`(() => {
    const keys = "jinitaimei114".split("");
    const keyboardCode = (key) =>
      /^[0-9]$/.test(key) ? "Digit" + key : "Key" + key.toUpperCase();
    for (const key of keys) {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key, code: keyboardCode(key), bubbles: true,
      }));
    }
    for (const key of keys) {
      window.dispatchEvent(new KeyboardEvent("keyup", {
        key, code: keyboardCode(key), bubbles: true,
      }));
    }
  })()`);
  await waitFor(
    client,
    `window.__polytrackCheatUnlocked === true &&
      document.querySelector("#polytrack-cheat-backdrop")?.hidden === false`,
    "cheat menu",
  );
}

async function enableBoost(client) {
  await unlockCheatMenu(client);
  await client.evaluate(`(() => {
    const values = ${JSON.stringify(boostValues)};
    for (const [key, value] of Object.entries(values)) {
      const input = document.getElementById("polytrack-cheat-" + key);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("polytrack-cheat-close")?.click();
  })()`);
}

async function driveToFinish(client, runLabel = "boosted") {
  await press(client, "ArrowUp", "keyDown");
  await waitFor(
    client,
    "window.__polytrackLocalCarId !== null && window.__polytrackWebglStates.some((state) => state.carId === window.__polytrackLocalCarId)",
    "local player simulation state",
  );
  // Sequence entries are [logical simulation frames, steering key]. This
  // keeps control durations stable when headless Chromium runs faster than
  // the browser's wall-clock frame rate.
  const sequence = JSON.parse(process.env.POLYTRACK_DRIVE_SEQUENCE ||
    '[[10000,null,"up"]]');
  let steering = null;
  let throttle = "up";
  const throttleKeys = { up: "ArrowUp", brake: "ArrowDown" };
  for (const [frames, nextSteering, nextThrottle = "up"] of sequence) {
    assert.ok(nextThrottle === "up" || nextThrottle === "coast" ||
      nextThrottle === "brake", `unsupported throttle mode: ${nextThrottle}`);
    if (nextSteering !== steering) {
      if (steering) await press(client, steering, "keyUp");
      if (nextSteering) await press(client, nextSteering, "keyDown");
      steering = nextSteering;
    }
    if (nextThrottle !== throttle) {
      const oldKey = throttleKeys[throttle];
      if (oldKey) await press(client, oldKey, "keyUp");
      const newKey = throttleKeys[nextThrottle];
      if (newKey) await press(client, newKey, "keyDown");
      throttle = nextThrottle;
    }
    const currentFrame = await currentLocalFrame(client);
    assert.ok(Number.isSafeInteger(currentFrame), "the local simulation has not emitted a frame");
    await waitForLogicalFrame(client, currentFrame + frames);
    if (await client.evaluate("window.__polytrackWebglStates.some((state) => state.finishFrame !== null)")) break;
  }
  const throttleKey = throttleKeys[throttle];
  if (throttleKey) await press(client, throttleKey, "keyUp");
  if (steering) await press(client, steering, "keyUp");
  const result = await client.evaluate(`(() => {
    const states = window.__polytrackWebglStates;
    const finish = states.find((state) => state.finishFrame !== null);
    return { states, finish, keyEvents: window.__polytrackKeyEvents };
  })()`);
  if (!result.finish && process.env.POLYTRACK_FAILURE_SCREENSHOT) {
    const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.POLYTRACK_FAILURE_SCREENSHOT,
      Buffer.from(screenshot.result.data, "base64"));
  }
  assert.ok(
    result.finish,
    `the real ${runLabel} browser run did not finish; adjust POLYTRACK_DRIVE_SEQUENCE. ` +
      `Last state: ${JSON.stringify(result.states.at(-1) ?? null)}; checkpoints: ` +
      `${[...new Set(result.states.map((state) => state.checkpoint))].join(",")}; keys: ` +
      `${JSON.stringify(result.keyEvents.slice(-24))}`,
  );
  assert.ok(result.states.some((state) => state.checkpoint > 0),
    "the real run produced no checkpoint state");
  return result;
}

test("a player joining by invite appears in the host's real player list", {
  skip: !multiplayerEnabled,
  timeout: timeoutMs * 3 + 30_000,
}, async (t) => {
  t.diagnostic(
    "Invite delivery and host visibility are checked here; TURN relay reachability is " +
      "checked separately by the relay-only integration test.",
  );
  const hostProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-multiplayer-host-"));
  const joinProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-multiplayer-join-"));
  const host = await launchProfile(hostProfile);
  let joiner;
  t.after(async () => {
    await Promise.all([host.close(), joiner?.close()].filter(Boolean));
    await Promise.all([
      rm(hostProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(joinProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ]);
  });

  await host.client.call("Page.enable");
  await host.client.call("Runtime.enable");
  const inviteCode = await hostGameWithInvite(host.client);
  assert.equal(
    await clickVisibleButton(host.client, ".invite-ui button", "Close"),
    true,
    "host could not close the invite screen",
  );
  assert.equal(
    await clickVisibleButton(host.client, ".game-ui button", "Players"),
    true,
    "host could not open the player list",
  );
  await waitFor(
    host.client,
    "document.querySelector('.player-list-ui .content')?.children.length === 1",
    "host-only player list",
  );

  joiner = await launchProfile(joinProfile);
  await joiner.client.call("Page.enable");
  await joiner.client.call("Runtime.enable");
  await joinWithInvite(joiner.client, inviteCode);
  await waitFor(
    host.client,
    "document.querySelector('.player-list-ui .content')?.children.length > 1",
    "joining player to appear in the host's player list",
  );
  const visiblePlayers = await host.client.evaluate(
    "document.querySelector('.player-list-ui .content')?.children.length ?? 0",
  );
  assert.ok(visiblePlayers > 1, "host did not display the joining player");
});

test("real PolyTrack delivers invites across separate API instances without logging private data", {
  skip: !crossInstanceMultiplayerEnabled,
  timeout: timeoutMs * 3 + 45_000,
}, async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL must point to the shared database for this integration test",
  );

  const hostProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-cross-instance-host-"));
  const joinProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-cross-instance-join-"));
  let hostApi;
  let joinApi;
  let host;
  let joiner;
  t.after(async () => {
    await Promise.all([host?.close(), joiner?.close()].filter(Boolean));
    await Promise.all([hostApi?.close(), joinApi?.close()].filter(Boolean));
    await Promise.all([
      rm(hostProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(joinProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ]);
  });

  hostApi = await launchApiInstance();
  joinApi = await launchApiInstance();
  assert.notEqual(hostApi.url, joinApi.url, "host and join clients need separate API instances");

  host = await launchProfile(hostProfile);
  await host.client.call("Page.enable");
  await host.client.call("Runtime.enable");
  await host.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createMultiplayerServerOverride(hostApi.url),
  });

  const inviteCode = await hostGameWithInvite(host.client);
  await sleep(100);
  const hostRoutes = await host.client.evaluate(
    "window.__crossInstanceSocketRoutes ?? []",
  );
  if (!hostApi.logs().includes('"role":"host"')) {
    t.diagnostic(JSON.stringify({
      hostRoutes,
      hostApiAcceptedHostSocket: false,
    }));
    assert.fail("the host WebSocket did not connect to its dedicated API instance");
  }
  assert.equal(
    await clickVisibleButton(host.client, ".invite-ui button", "Close"),
    true,
    "host could not close the invite screen",
  );
  assert.equal(
    await clickVisibleButton(host.client, ".game-ui button", "Players"),
    true,
    "host could not open the player list",
  );
  await waitFor(
    host.client,
    "document.querySelector('.player-list-ui .content')?.children.length === 1",
    "host-only player list",
  );

  joiner = await launchProfile(joinProfile);
  await joiner.client.call("Page.enable");
  await joiner.client.call("Runtime.enable");
  await joiner.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createMultiplayerServerOverride(
      joinApi.url,
      crossInstancePlayerNickname,
    ),
  });
  await joinWithInvite(joiner.client, inviteCode);
  try {
    await waitFor(
      host.client,
      "document.querySelector('.player-list-ui .content')?.children.length > 1",
      "joining player delivered through the cross-instance signaling queue",
      20_000,
    );
  } catch {
    await sleep(100);
    const [joinRoutes, visiblePlayerCount] = await Promise.all([
      joiner.client.evaluate("window.__crossInstanceSocketRoutes ?? []"),
      host.client.evaluate(
        "document.querySelector('.player-list-ui .content')?.children.length ?? 0",
      ),
    ]);
    t.diagnostic(JSON.stringify({
      hostRoutes,
      joinRoutes,
      visiblePlayerCount,
      hostApiAcceptedHostSocket: hostApi.logs().includes('"role":"host"'),
      joinApiAcceptedJoinSocket: joinApi.logs().includes('"role":"join"'),
      joinApiQueuedInvite: joinApi.logs().includes('"delivery":"queued-for-host"'),
      hostApiDeliveredQueuedInvite: hostApi.logs().includes('"delivery":"sent-to-host"'),
      joinApiEvents: summarizeMultiplayerApiLogs(joinApi),
      hostApiEvents: summarizeMultiplayerApiLogs(hostApi),
    }));
    throw new Error("cross-instance signaling did not show the joining player to the host");
  }

  assert.ok(
    joinApi.logs().includes('"delivery":"queued-for-host"'),
    "the join API instance did not record queued host delivery",
  );
  assert.ok(
    hostApi.logs().includes('"delivery":"sent-to-host"'),
    "the host API instance did not record delivery from its signaling queue",
  );
  assert.ok(
    hostApi.logs().includes('"role":"host"') &&
      !hostApi.logs().includes('"role":"join"'),
    "the host WebSocket did not stay on its dedicated API instance",
  );
  assert.ok(
    joinApi.logs().includes('"role":"join"') &&
      !joinApi.logs().includes('"role":"host"'),
    "the join WebSocket did not stay on its dedicated API instance",
  );

  const capturedApiLogs = `${hostApi.logs()}\n${joinApi.logs()}`;
  assert.equal(
    capturedApiLogs.includes(inviteCode),
    false,
    "multiplayer server logs included an invite code",
  );
  assert.equal(
    capturedApiLogs.includes(crossInstancePlayerNickname),
    false,
    "multiplayer server logs included a player nickname",
  );
});

test("multiplayer data channels use TCP/TLS TURN when UDP and direct ICE routes are blocked", {
  skip: !multiplayerRelayEnabled,
  timeout: timeoutMs * 3 + 30_000,
}, async (t) => {
  t.diagnostic(
    "This check removes UDP TURN URLs, forces relay-only ICE, and requires a selected " +
      "TCP/TLS relay pair plus an open game data channel in both browsers.",
  );
  const hostProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-relay-host-"));
  const joinProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-relay-join-"));
  const host = await launchProfile(hostProfile);
  let joiner;
  t.after(async () => {
    await Promise.all([host.close(), joiner?.close()].filter(Boolean));
    await Promise.all([
      rm(hostProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(joinProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ]);
  });

  await host.client.call("Page.enable");
  await host.client.call("Runtime.enable");
  await host.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createRelayOnlyProbe(),
  });
  const inviteCode = await hostGameWithInvite(host.client);
  assert.equal(
    await clickVisibleButton(host.client, ".invite-ui button", "Close"),
    true,
    "host could not close the invite screen",
  );
  assert.equal(
    await clickVisibleButton(host.client, ".game-ui button", "Players"),
    true,
    "host could not open the player list",
  );
  await waitFor(
    host.client,
    "document.querySelector('.player-list-ui .content')?.children.length === 1",
    "host-only player list",
  );

  joiner = await launchProfile(joinProfile);
  await joiner.client.call("Page.enable");
  await joiner.client.call("Runtime.enable");
  await joiner.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createRelayOnlyProbe(),
  });
  await joinWithInvite(joiner.client, inviteCode);
  await waitFor(
    host.client,
    "document.querySelector('.player-list-ui .content')?.children.length > 1",
    "joining player to appear in the host's player list",
  );

  const probeStatus = await Promise.all([host.client, joiner.client].map(
    (client) => client.evaluate("window.__polytrackRelayProbeStatus?.() ?? null"),
  ));
  assert.ok(
    probeStatus.every((status) => status?.patched === true),
    "relay-only ICE policy was not installed in both browsers",
  );
  assert.ok(
    probeStatus.every((status) =>
      status.configuredRelayTransports?.includes("tcp") &&
      status.configuredRelayTransports?.includes("tls")),
    "both TCP and TLS TURN routes were not supplied to the browsers",
  );
  const pageModes = await Promise.all([host.client, joiner.client].map(
    (client) => client.evaluate(`(() => ({
      gameVisible: Boolean(document.querySelector(".game-ui")?.offsetWidth),
      multiplayerVisible: Boolean(document.querySelector(".multiplayer-ui")?.offsetWidth),
      playerListVisible: Boolean(document.querySelector(".player-list-ui")?.offsetWidth),
      inviteVisible: Boolean(document.querySelector(".invite-ui")?.offsetWidth),
    }))()`),
  ));
  t.diagnostic(
    `Invite/signaling UI reached both browsers (page modes: ${JSON.stringify(pageModes)}); ` +
      `relay probe observed ${probeStatus[0].dataChannelAttempts} host and ` +
      `${probeStatus[1].dataChannelAttempts} joining-browser data-channel creations.`,
  );

  const relayState = await waitForRelayDataChannel(host.client, joiner.client);
  assert.ok(
    relayState.host.some((connection) =>
      connection.iceTransportPolicy === "relay" &&
      connection.selectedPair?.localCandidateType === "relay" &&
      connection.selectedPair?.remoteCandidateType === "relay" &&
      ["tcp", "tls"].includes(connection.selectedPair.localRelayProtocol) &&
      ["tcp", "tls"].includes(connection.selectedPair.remoteRelayProtocol) &&
      connection.openDataChannels > 0),
    "host did not open a data channel over a selected TCP/TLS relay pair",
  );
  assert.ok(
    relayState.joiner.some((connection) =>
      connection.iceTransportPolicy === "relay" &&
      connection.selectedPair?.localCandidateType === "relay" &&
      connection.selectedPair?.remoteCandidateType === "relay" &&
      ["tcp", "tls"].includes(connection.selectedPair.localRelayProtocol) &&
      ["tcp", "tls"].includes(connection.selectedPair.remoteRelayProtocol) &&
      connection.openDataChannels > 0),
    "joining browser did not open a data channel over a selected TCP/TLS relay pair",
  );
  const selectedRelayProtocols = (connections) => connections
    .filter((connection) =>
      connection.selectedPair?.localCandidateType === "relay" &&
      connection.selectedPair?.remoteCandidateType === "relay" &&
      connection.openDataChannels > 0)
    .map((connection) => ({
      local: connection.selectedPair.localRelayProtocol,
      remote: connection.selectedPair.remoteRelayProtocol,
    }));
  t.diagnostic(
    "TCP/TLS relay connection passed: both browsers selected relay/relay candidate " +
      "pairs using TCP or TLS and opened the multiplayer data channel. UDP TURN URLs " +
      "and direct ICE routes were excluded. Selected relay protocols: " +
      JSON.stringify({
        host: selectedRelayProtocols(relayState.host),
        joiner: selectedRelayProtocols(relayState.joiner),
      }),
  );
});

test("large public leaderboards keep later-page navigation and rows correct", {
  skip: !enabled,
  timeout: timeoutMs * 2,
}, async (t) => {
  const trackFixture = (await readFile(
    path.join(__dirname, "fixtures", "webgl-community-part.track"), "utf8",
  )).trim();
  const testTrackId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const replayApi = await createReplayTestApi();
  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-large-leaderboard-"),
  );
  let browser;
  t.after(async () => {
    await Promise.all([browser?.close(), replayApi.close()].filter(Boolean));
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  const total = 161;
  for (let index = 0; index < total; index += 1) {
    const form = new URLSearchParams({
      version: "v6",
      userToken: `large-page-${index}-${randomUUID()}`,
      nickname: `Page Driver ${index + 1}`,
      carStyle: "default",
      trackId: testTrackId,
      frames: String(100 + index),
      recording: `large-page-controls-${index}`,
    });
    if (index % 3 === 0) {
      form.set("replayBoostSettings", JSON.stringify({
        accelerationMultiplier: 1.5,
        brakingMultiplier: 1,
        topSpeedMultiplier: 1.2,
      }));
    } else if (index % 3 === 1) {
      form.set("normalPhysicsConfirmed", "true");
    }
    const response = await fetch(`${replayApi.url}/api/v6/leaderboard`, {
      method: "POST", body: form,
    });
    assert.equal(response.status, 200, `could not seed record ${index + 1}`);
  }

  browser = await launchProfile(profileDirectory);
  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(browser.client);

  async function assertPage(pageNumber) {
    const expectedNames = Array.from({ length: 20 }, (_, index) =>
      `Page Driver ${(pageNumber - 1) * 20 + index + 1}`);
    await waitFor(
      browser.client,
      `(() => {
        const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
        const names = [...(leaderboard?.querySelectorAll(
          ".container button.main .name",
        ) ?? [])].map((name) => name.textContent.trim());
        return leaderboard?.querySelector(".total-players")?.textContent.trim() ===
            ${JSON.stringify(`${total} players`)} &&
          leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() ===
            ${JSON.stringify(String(pageNumber))} &&
          JSON.stringify(names) === ${JSON.stringify(JSON.stringify(expectedNames))} &&
          !leaderboard.querySelector(
            "#polytrack-leaderboard-boost-filter, .polytrack-boost-status",
          );
      })()`,
      `public page ${pageNumber} with its correct total and exact rows`,
    );
  }
  async function clickPage(label) {
    const clicked = await browser.client.evaluate(`(() => {
      const button = [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .pages button",
      )].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, `page control ${label} is usable`);
  }

  await assertPage(1);
  const initiallyShowsPageEight = await browser.client.evaluate(`(() =>
    [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .pages button.page",
    )].some((button) => button.textContent.trim() === "8")
  )()`);
  assert.equal(initiallyShowsPageEight, false, "page eight starts outside the numbered window");
  for (let pageNumber = 2; pageNumber <= 7; pageNumber += 1) {
    await clickPage(">");
    await assertPage(pageNumber);
  }
  await clickPage("8");
  await assertPage(8);
  await clickPage("7");
  await assertPage(7);

  const requests = replayApi.getLeaderboardRequests();
  assert.ok(requests.every((request) => request.replayBoostStatus === null),
    "public pagination never requests a replay boost category");
  assert.deepEqual(requests.slice(-2).map(({ skip, amount }) => ({ skip, amount })), [
    { skip: 140, amount: 20 },
    { skip: 120, amount: 20 },
  ], "later numbered pages request the correct slices in both directions");
});

test("leaderboard replay labels stay readable on phones while pagination works (removed public UI)", {
  skip: "Public replay boost UI removed; covered by private Watch and public-privacy regression tests",
  timeout: timeoutMs * 2,
}, async (t) => {
  const trackFixture = (await readFile(
    path.join(__dirname, "fixtures", "webgl-community-part.track"), "utf8",
  )).trim();
  const testTrackId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const replayApi = await createReplayTestApi();
  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-leaderboard-pages-"),
  );
  let browser;
  t.after(async () => {
    await Promise.all([browser?.close(), replayApi.close()].filter(Boolean));
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  const statuses = ["boosted", "not-boosted", "unknown"];
  const boostSettings = {
    accelerationMultiplier: 1.5,
    brakingMultiplier: 1,
    topSpeedMultiplier: 1.2,
  };
  for (let index = 0; index < 21; index += 1) {
    for (let statusIndex = 0; statusIndex < statuses.length; statusIndex += 1) {
      const status = statuses[statusIndex];
      const displayStatus = status === "not-boosted"
        ? "Confirmed normal"
        : status === "unknown" ? "Legacy unknown" : "Boosted";
      const nickname = `${displayStatus} replay ${index + 1}`;
      const form = new URLSearchParams({
        version: "v6",
        userToken: `${status}-${index}-${randomUUID()}`,
        nickname,
        carStyle: "default",
        trackId: testTrackId,
        frames: String(100 + index * statuses.length + statusIndex),
        recording: `${nickname}-controls`,
      });
      if (status === "boosted") {
        form.set("replayBoostSettings", JSON.stringify(boostSettings));
      } else if (status === "not-boosted") {
        form.set("normalPhysicsConfirmed", "true");
      }
      const response = await fetch(`${replayApi.url}/api/v6/leaderboard`, {
        method: "POST",
        body: form,
      });
      assert.equal(response.status, 200,
        `could not seed ${status} replay ${index + 1}`);
    }
  }

  browser = await launchProfile(profileDirectory);
  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(browser.client);
  await waitFor(
    browser.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      const rows = leaderboard?.querySelectorAll(".container button.main") ?? [];
      return leaderboard?.querySelector("#polytrack-leaderboard-boost-filter select") &&
        rows.length === 20 &&
        [...rows].every((row) => {
          const status = row.getAttribute("data-polytrack-boost-status");
          const expectedLabel = status === "not-boosted"
            ? "NOT BOOSTED"
            : status?.toUpperCase();
          return ["boosted", "not-boosted", "unknown"].includes(status) &&
            row.querySelector(".polytrack-boost-status")?.textContent === expectedLabel;
        }) &&
        leaderboard.querySelector(".total-players")?.textContent.trim() === "63 players";
    })()`,
    "the first mixed leaderboard page and its readable replay classifications",
  );
  const firstPageStatuses = await browser.client.evaluate(`(() => {
    const rows = [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .container button.main",
    )];
    return [...new Set(rows.map((row) =>
      row.getAttribute("data-polytrack-boost-status")))].sort();
  })()`);
  assert.deepEqual(firstPageStatuses, ["boosted", "not-boosted", "unknown"],
    "legacy unknown runs remain distinct from confirmed normal physics");
  await browser.client.call("Accessibility.enable");
  const accessibilityTree = await browser.client.call("Accessibility.getFullAXTree");
  const accessibleLeaderboardButtons = accessibilityTree.result.nodes
    .filter((node) => node.role?.value === "button" &&
      ["Boosted replay 1", "Confirmed normal replay 1", "Legacy unknown replay 1"]
        .some((nickname) => node.name?.value.includes(nickname)))
    .map((node) => node.name?.value ?? "");
  const expectedAccessibleReplayRows = [
    {
      nickname: "Boosted replay 1",
      label: "Replay boost status: BOOSTED",
    },
    {
      nickname: "Confirmed normal replay 1",
      label: "Replay boost status: NOT BOOSTED",
    },
    {
      nickname: "Legacy unknown replay 1",
      label: "Replay boost status: UNKNOWN",
    },
  ];
  for (const { nickname, label } of expectedAccessibleReplayRows) {
    const accessibleName = accessibleLeaderboardButtons.find((name) =>
      name.includes(nickname));
    assert.ok(accessibleName,
      `${nickname} is missing from the browser accessibility tree`);
    assert.ok(accessibleName.includes(label),
      `${nickname} accessibility name omitted ${label}: ${accessibleName}`);
  }
  t.diagnostic(`Leaderboard accessibility names: ${
    JSON.stringify(accessibleLeaderboardButtons)
  }`);
  const phoneLayouts = await assertPhoneLeaderboardLayout(browser.client);
  t.diagnostic(`Phone leaderboard layouts: ${JSON.stringify(phoneLayouts)}`);
  await browser.client.call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const firstNames = await browser.client.evaluate(`(() =>
    [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .container button.main .name",
    )].map((name) => name.textContent.trim())
  )()`);
  const openedPageTwo = await browser.client.evaluate(`(() => {
    const button = [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .pages button.page",
    )].find((item) => item.textContent.trim() === "2");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openedPageTwo, true, "the unfiltered leaderboard exposes page two");
  await waitFor(
    browser.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      const rows = [...(leaderboard?.querySelectorAll(".container button.main") ?? [])];
      return leaderboard?.querySelector("#polytrack-leaderboard-boost-filter select")?.value === "all" &&
        rows.length === 20 &&
        rows.every((row) => row.querySelector(".polytrack-boost-status")) &&
        leaderboard.querySelector(".total-players")?.textContent.trim() === "63 players" &&
        leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() === "2";
    })()`,
    "the second unfiltered leaderboard page with replay classifications",
  );
  const secondNames = await browser.client.evaluate(`(() =>
    [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .container button.main .name",
    )].map((name) => name.textContent.trim())
  )()`);
  assert.equal(new Set([...firstNames, ...secondNames]).size, 40,
    "normal leaderboard pagination still returns distinct entries");
  const returnedToPageOne = await browser.client.evaluate(`(() => {
    const button = [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .pages button.page",
    )].find((item) => item.textContent.trim() === "1");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(returnedToPageOne, true, "the unfiltered leaderboard returns to page one");
  await waitFor(
    browser.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      return leaderboard?.querySelector("#polytrack-leaderboard-boost-filter select")?.value === "all" &&
        leaderboard.querySelector(".container button.main") &&
        leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() === "1";
    })()`,
    "the unfiltered first page after checking pagination",
  );

  const pageResults = {};
  for (const status of statuses) {
    await browser.client.evaluate(`(() => {
      const filter = document.querySelector(
        "#polytrack-leaderboard-boost-filter select",
      );
      filter.value = ${JSON.stringify(status)};
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(
      browser.client,
      `(() => {
        const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
        const filter = leaderboard?.querySelector(
          "#polytrack-leaderboard-boost-filter select",
        );
        const rows = [...(leaderboard?.querySelectorAll(".container button.main") ?? [])];
        return filter?.value === ${JSON.stringify(status)} &&
          rows.length === 20 &&
          rows.every((row) =>
            row.getAttribute("data-polytrack-boost-status") === ${JSON.stringify(status)}) &&
          leaderboard.querySelector(".total-players")?.textContent.trim() === "21 players" &&
          leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() === "1";
      })()`,
      `${status} first page with its filtered total`,
    );
    const firstNames = await browser.client.evaluate(`(() =>
      [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main .name",
      )].map((name) => name.textContent.trim())
    )()`);

    const openedPageTwo = await browser.client.evaluate(`(() => {
      const button = [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .pages button.page",
      )].find((item) => item.textContent.trim() === "2");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(openedPageTwo, true, `${status} did not expose page two`);
    await waitFor(
      browser.client,
      `(() => {
        const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
        const filter = leaderboard?.querySelector(
          "#polytrack-leaderboard-boost-filter select",
        );
        const rows = [...(leaderboard?.querySelectorAll(".container button.main") ?? [])];
        return filter?.value === ${JSON.stringify(status)} &&
          rows.length === 1 &&
          rows[0].getAttribute("data-polytrack-boost-status") === ${JSON.stringify(status)} &&
          leaderboard.querySelector(".total-players")?.textContent.trim() === "21 players" &&
          leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() === "2";
      })()`,
      `${status} second page`,
    );
    const secondNames = await browser.client.evaluate(`(() =>
      [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main .name",
      )].map((name) => name.textContent.trim())
    )()`);
    const secondPageLabel = await browser.client.evaluate(`(() =>
      document.querySelector(
        ".track-info-ui .leaderboard-ui .container button.main .polytrack-boost-status",
      )?.textContent.trim()
    )()`);

    const returnedToPageOne = await browser.client.evaluate(`(() => {
      const button = [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .pages button.page",
      )].find((item) => item.textContent.trim() === "1");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(returnedToPageOne, true, `${status} could not return to page one`);
    await waitFor(
      browser.client,
      `(() => {
        const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
        return leaderboard?.querySelector(
          "#polytrack-leaderboard-boost-filter select",
        )?.value === ${JSON.stringify(status)} &&
          leaderboard.querySelector(".container button.main") &&
          leaderboard.querySelector(".pages button.page.selected")?.textContent.trim() === "1";
      })()`,
      `${status} first page after returning`,
    );
    pageResults[status] = {
      firstPageCount: firstNames.length,
      secondPageCount: secondNames.length,
      uniqueCount: new Set([...firstNames, ...secondNames]).size,
      secondPageLabel,
    };
  }

  assert.deepEqual(pageResults, {
    boosted: {
      firstPageCount: 20, secondPageCount: 1, uniqueCount: 21,
      secondPageLabel: "BOOSTED",
    },
    "not-boosted": {
      firstPageCount: 20, secondPageCount: 1, uniqueCount: 21,
      secondPageLabel: "NOT BOOSTED",
    },
    unknown: {
      firstPageCount: 20, secondPageCount: 1, uniqueCount: 21,
      secondPageLabel: "UNKNOWN",
    },
  }, "each category keeps its filter, total, and every distinct result across pages");
  const requests = replayApi.getLeaderboardRequests();
  assert.ok(requests.some((request) =>
    request.replayBoostStatus === null && request.skip === 0 &&
    request.amount === 20),
  "page one requests are not classified");
  assert.ok(requests.some((request) =>
    request.replayBoostStatus === null && request.skip === 20 &&
    request.amount === 20),
  "page two requests are not classified");

  await browser.client.evaluate(`(() => {
    const filter = document.querySelector(
      "#polytrack-leaderboard-boost-filter select",
    );
    filter.value = "all";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    browser.client,
    `document.querySelector(
      ".track-info-ui .leaderboard-ui .pages button.page.selected",
    )?.textContent.trim() === "1" &&
      document.querySelector(
        "#polytrack-leaderboard-boost-filter select",
      )?.value === "all" &&
      document.querySelector(
        ".track-info-ui .leaderboard-ui .total-players",
      )?.textContent.trim() === "63 players" &&
      [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main",
      )].some((button) =>
        button.textContent.includes("Legacy unknown replay 1"))`,
    "the mixed first leaderboard page before keyboard selection",
  );
  replayApi.setBoostStatusEmpty(testTrackId, "unknown", true);
  await browser.client.evaluate(`(() => {
    const filter = document.querySelector(
      "#polytrack-leaderboard-boost-filter select",
    );
    filter.value = "unknown";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    browser.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      const pages = leaderboard?.querySelector(".pages");
      return leaderboard?.querySelector(
        "#polytrack-leaderboard-boost-filter select",
      )?.value === "unknown" &&
        leaderboard.querySelectorAll(".container button.main").length === 0 &&
        leaderboard.querySelector(".total-players")?.textContent.trim() === "0 players" &&
        pages?.hidden === true &&
        pages.querySelectorAll("button").length === 0;
    })()`,
    "an empty replay boost category clears prior rows, totals, and page controls",
  );
  replayApi.setBoostStatusEmpty(testTrackId, "unknown", false);
  await browser.client.evaluate(`(() => {
    const filter = document.querySelector(
      "#polytrack-leaderboard-boost-filter select",
    );
    filter.value = "all";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    browser.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      return leaderboard?.querySelector(
        "#polytrack-leaderboard-boost-filter select",
      )?.value === "all" &&
        leaderboard.querySelectorAll(".container button.main").length === 20 &&
        leaderboard.querySelector(".total-players")?.textContent.trim() === "63 players" &&
        [...leaderboard.querySelectorAll(".container button.main")]
          .some((row) => row.textContent.includes("Legacy unknown replay 1")) &&
        leaderboard.querySelector(".pages")?.hidden === false;
    })()`,
    "the full leaderboard restores its rows and page controls after an empty filter",
  );
  const keyboardRowFocus = await browser.client.evaluate(`(() => {
    const nickname = "Legacy unknown replay 1";
    const row = [...document.querySelectorAll(
      ".track-info-ui .leaderboard-ui .container button.main",
    )].find((button) => button.textContent.includes(nickname));
    if (!row) return { found: false };
    window.__polytrackKeyboardRowClicks = [];
    document.addEventListener("click", (event) => {
      const clickedRow = event.target.closest?.(
        ".track-info-ui .leaderboard-ui .container button.main",
      );
      if (clickedRow) {
        window.__polytrackKeyboardRowClicks.push(
          clickedRow.textContent.includes(nickname),
        );
      }
    }, true);
    row.focus();
    return {
      found: true,
      isButton: row instanceof HTMLButtonElement,
      tabIndex: row.tabIndex,
      focused: document.activeElement === row,
    };
  })()`);
  assert.deepEqual(keyboardRowFocus, {
    found: true,
    isButton: true,
    tabIndex: 0,
    focused: true,
  }, "leaderboard replay entries remain keyboard-focusable buttons");
  await pressSpace(browser.client);
  await sleep(250);
  const keyboardSelectionState = await browser.client.evaluate(`(() => {
    const watch = [...document.querySelectorAll(
      ".track-info-ui button, .track-info-ui [role=button]",
    )].find((button) => button.textContent.trim() === "Watch");
    return {
      rowClicks: window.__polytrackKeyboardRowClicks,
      watchAvailable: Boolean(watch && !watch.disabled),
    };
  })()`);
  assert.deepEqual(keyboardSelectionState.rowClicks, [true],
    `Space did not activate the focused leaderboard entry: ${
      JSON.stringify(keyboardSelectionState)
    }`);
  assert.equal(keyboardSelectionState.watchAvailable, true,
    `Watch was not available after keyboard-selecting the entry: ${
      JSON.stringify(keyboardSelectionState)
    }`);

  await unlockCheatMenu(browser.client);
  await browser.client.evaluate(
    "document.getElementById('polytrack-cheat-close')?.click()",
  );
  const keyboardWatchFocus = await browser.client.evaluate(`(() => {
    const watch = [...document.querySelectorAll(".track-info-ui .button")]
      .find((button) => button.textContent.trim() === "Watch");
    if (!watch || watch.disabled) return { focused: false, tabIndex: null };
    watch.focus();
    return {
      focused: document.activeElement === watch,
      tabIndex: watch.tabIndex,
    };
  })()`);
  assert.deepEqual(keyboardWatchFocus, { focused: true, tabIndex: 0 },
    "the enabled Watch control remains keyboard-focusable");
  await pressSpace(browser.client);
  const keyboardLauncherFocus = await browser.client.evaluate(`(() => {
    const launcher = document.getElementById("polytrack-cheat-launcher");
    if (!launcher || launcher.hidden) return { focused: false };
    launcher.focus();
    return { focused: document.activeElement === launcher };
  })()`);
  assert.deepEqual(keyboardLauncherFocus, { focused: true },
    "the replay-status control can be reached after keyboard activation of Watch");
  await pressSpace(browser.client);
  await waitFor(
    browser.client,
    `(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      return status && !status.hidden &&
        /Replay boost: (?:checking replay data|UNKNOWN)/.test(status.textContent);
    })()`,
    "the replay status after starting Watch with the keyboard",
  );
});

test("native post-race Watch displays private boost status and Back clears it", {
  skip: !enabled,
  timeout: timeoutMs * 2,
}, async (t) => {
  const trackFixture = (await readFile(
    path.join(__dirname, "fixtures", "webgl-community-part.track"), "utf8",
  )).trim();
  const testTrackId = createHash("sha256").update(`${trackFixture}:${randomUUID()}`).digest("hex");
  const replayApi = await createReplayTestApi();
  const profile = await mkdtemp(path.join(os.tmpdir(), "polytrack-private-watch-"));
  const browser = await launchProfile(profile);
  t.after(async () => {
    await browser.close();
    await replayApi.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(browser.client);
  assert.equal(await browser.client.evaluate(
    "Boolean(document.querySelector('#polytrack-leaderboard-boost-filter, .polytrack-boost-status'))"),
  false, "no public boost controls or labels");
  await startSelectedTrack(browser.client);
  await driveToFinish(browser.client, "private-status-fixture");
  // This tests classification/visibility, not boosted physics. Mark only the
  // isolated fixture PB; no real community-track entry or user PB is changed.
  await browser.client.evaluate(`(() => {
    const key = Object.keys(localStorage).find(key =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'));
    if (!key) throw new Error("fixture PB was not saved");
    const record = JSON.parse(localStorage.getItem(key));
    record.replayBoostSettings = {
      accelerationMultiplier: 1.8, brakingMultiplier: 1, topSpeedMultiplier: 1,
    };
    localStorage.setItem(key, JSON.stringify(record));
    window.__polytrackReplayBoostSettingsByRecording.set(record.recording, record.replayBoostSettings);
  })()`);
  assert.equal(await clickVisibleButton(browser.client, "button", "Watch"), true,
    "the post-race Watch button was available");
  await waitFor(browser.client, "Boolean(document.querySelector('.preview-toolbar-ui'))",
    "native replay view");
  await unlockCheatMenu(browser.client);
  await waitFor(browser.client, `(() => {
    const status = document.getElementById("polytrack-cheat-replay-status");
    return status && !status.hidden && status.textContent === "Replay boost: BOOSTED";
  })()`, "private boosted status in actual Watch");
  const screenshot = await browser.client.call("Page.captureScreenshot", { format: "jpeg" });
  await writeFile("/tmp/polytrack-private-watch.jpg", Buffer.from(screenshot.result.data, "base64"));
  await browser.client.evaluate("document.getElementById('polytrack-cheat-close').click()");
  assert.equal(await clickVisibleButton(browser.client, ".preview-toolbar-ui button", "Back"), true);
  await browser.client.evaluate("document.getElementById('polytrack-cheat-launcher').click()");
  assert.equal(await browser.client.evaluate(
    "document.getElementById('polytrack-cheat-replay-status').hidden"), true,
  "native Back ends the private status");
});

test("boosted WebGL leaderboard replay finishes on a map with a newer community part", {
  skip: !enabled && !cloudflareReplayEnabled,
  timeout: timeoutMs * 2 + 30_000,
}, async (t) => {
  const trackFixture = (await readFile(
    path.join(__dirname, "fixtures", "webgl-community-part.track"), "utf8",
  )).trim();
  const [{ patchPolytrackMainBundle }, rawBundle] = await Promise.all([
    import("../main-bundle-startup-patch.js"),
    readFile(path.join(__dirname, "../public/main.bundle.js"), "utf8"),
  ]);
  globalThis.self ??= globalThis;
  globalThis.window ??= globalThis;
  const modules = loadBundleModules(patchPolytrackMainBundle(rawBundle));
  const parsedFixture = parseTrack(trackFixture, [
    modules(5440).U,
    modules(9681).U,
  ]);
  assert.ok(parsedFixture, "the community-part replay fixture decodes as a track");
  const fixturePartIds = new Set();
  parsedFixture.trackData.forEachPart((_x, _y, _z, type) => fixturePartIds.add(type));
  assert.ok(fixturePartIds.has(188),
    "the browser fixture contains the project-added BlockOuterCorner part");
  assert.ok(parsedFixture.trackData.hasStartingPoint(),
    "the community-part fixture retains a finishable start");
  const testTrackId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const replayApi = cloudflareReplayEnabled ? null : await createReplayTestApi();
  let liveCleanupState = null;
  const firstProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-webgl-run-"));
  const secondProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-webgl-replay-"));
  const first = await launchProfile(firstProfile);
  let second;
  t.after(async () => {
    await Promise.all([
      first.close(), second?.close(), replayApi?.close(),
    ].filter(Boolean));
    await Promise.all([
      rm(firstProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(secondProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ]);
    if (liveCleanupState) {
      const response = await fetch(new URL("/api/v6/leaderboard", browserUrl), {
        method: "DELETE",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          userToken: liveCleanupState.userToken,
          trackId: liveCleanupState.trackId,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Could not remove the temporary Cloudflare test entry (HTTP ${response.status}); ` +
          `the unique test track is ${liveCleanupState.trackId}`,
        );
      }
      const result = await response.json();
      if (!Number.isSafeInteger(result?.deletedRecords) ||
          result.deletedRecords < 0 ||
          result.deletedRecords > 1 ||
          (liveCleanupState.uploadSucceeded && result.deletedRecords !== 1)) {
        throw new Error(
          `Cloudflare test-entry cleanup returned an unexpected result: ` +
          `${JSON.stringify(result)}`,
        );
      }
    }
  });

  await first.client.call("Page.enable");
  await first.client.call("Runtime.enable");
  await first.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi?.url ?? null),
  });
  await startTrack(first.client);
  assert.ok(await first.client.evaluate("window.__polytrackFixtureLoads > 0"),
    "the first profile loaded the map fixture with the newer community part");
  assert.equal(await first.client.evaluate("window.__polytrackWebglAvailable"), true,
    "Chromium did not provide a real WebGL context");
  await enableBoost(first.client);
  const run = await driveToFinish(first.client);

  if (cloudflareReplayEnabled) {
    const userToken = await first.client.evaluate(`(() => {
      const profileKey = Object.keys(localStorage).find((key) =>
        /^polytrack_v5_(?:prod|dev|beta)_user_/.test(key));
      const profile = profileKey && JSON.parse(localStorage.getItem(profileKey));
      return typeof profile?.token === "string" ? profile.token : null;
    })()`);
    assert.ok(userToken, "fresh live test profile did not save its temporary token");
    liveCleanupState = {
      trackId: testTrackId,
      userToken,
      uploadSucceeded: false,
    };
  }

  const upload = await first.client.evaluate(`(async () => {
    const recordKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'));
    const profileKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_user_/.test(key));
    const record = recordKey && JSON.parse(localStorage.getItem(recordKey));
    const profile = profileKey && JSON.parse(localStorage.getItem(profileKey));
    if (!record || !profile) throw new Error("finished run was not saved to local storage");
    const savedRecordValue = localStorage.getItem(recordKey);
    const trackId = ${JSON.stringify(testTrackId)};
    profile.nickname = "WebGL Replay " + crypto.randomUUID().slice(0, 8);
    localStorage.setItem(profileKey, JSON.stringify(profile));
    const form = new URLSearchParams({
      version: "v6", userToken: profile.token, nickname: profile.nickname,
      carStyle: profile.carStyle, trackId, frames: String(record.frames),
      recording: record.recording, onlyVerified: "true",
      replayBoostSettings: JSON.stringify(record.replayBoostSettings),
      replayBoostTimeline: JSON.stringify(record.replayBoostTimeline),
    });
    const response = await fetch("/api/v6/leaderboard", { method: "POST", body: form });
    if (!response.ok) throw new Error("leaderboard upload returned " + response.status);
    return {
      ...(await response.json()),
      trackId,
      frames: record.frames,
      nickname: profile.nickname,
      diagnostics: {
        localCarId: window.__polytrackLocalCarId,
        cheatUnlocked: window.__polytrackCheatUnlocked,
        cheatSettings: window.__polytrackCheatSettings,
        pendingBoostSettings: window.__polytrackPendingReplayBoostSettings,
        pendingBoostTimeline: window.__polytrackPendingReplayBoostTimeline,
        pendingNormalPhysicsConfirmed: window.__polytrackPendingNormalPhysicsConfirmed,
        capturedBoostFrames: window.__polytrackBoostFrameBatches.slice(0, 3),
        recordWrites: window.__polytrackRecordWrites.slice(-5),
      },
      recordKey,
      savedRecordValue,
      savedRecord: {
        frames: record.frames,
        recording: record.recording,
        replayBoostSettings: record.replayBoostSettings ?? null,
        replayBoostTimeline: record.replayBoostTimeline ?? null,
      },
    };
  })()`);
  if (liveCleanupState) liveCleanupState.uploadSucceeded = true;
  assert.ok(Number.isSafeInteger(upload.uploadId), "upload did not return an id");
  assert.ok(upload.savedRecord.recording.length > 0,
    "the completed boosted run was saved with a recording");
  assert.ok(upload.savedRecord.replayBoostSettings,
    `the completed run saved its replay boost settings: ${JSON.stringify(upload.diagnostics)}`);
  assert.ok(upload.savedRecord.replayBoostTimeline,
    "the completed run saved its replay boost timeline");
  assert.equal(upload.savedRecord.frames, run.finish.finishFrame,
    "the saved boosted record uses the logical finish frame");

  if (replayApi) {
    for (const [nickname, userToken, frames, normalPhysicsConfirmed] of [
      ["Filter normal run", `normal-${randomUUID()}`, run.finish.finishFrame + 1, true],
      ["Filter unknown run", `unknown-${randomUUID()}`, run.finish.finishFrame + 2, false],
    ]) {
      const form = new URLSearchParams({
        version: "v6",
        userToken,
        nickname,
        carStyle: "default",
        trackId: testTrackId,
        frames: String(frames),
        recording: `${nickname}-controls`,
      });
      if (normalPhysicsConfirmed) form.set("normalPhysicsConfirmed", "true");
      const response = await fetch(`${replayApi.url}/api/v6/leaderboard`, {
        method: "POST",
        body: form,
      });
      assert.equal(response.status, 200, `could not seed ${nickname} for filter coverage`);
    }
  }

  second = await launchProfile(secondProfile);
  await second.client.call("Page.enable");
  await second.client.call("Runtime.enable");
  await second.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi?.url ?? null),
  });
  await openTrack(second.client);
  const replay = await second.client.evaluate(`(async () => {
    const response = await fetch("/api/v6/recordings?ids=${upload.uploadId}");
    if (!response.ok) throw new Error("recording lookup returned " + response.status);
    const [record] = await response.json();
    if (!record?.replayBoostSettings || !record?.replayBoostTimeline) {
      throw new Error("uploaded replay did not retain boost metadata");
    }
    return record;
  })()`);
  assert.equal(replay.frames, upload.frames);
  assert.deepEqual(replay.replayBoostSettings,
    upload.savedRecord.replayBoostSettings,
    "the uploaded record retained the settings used during the saved run");
  assert.deepEqual(replay.replayBoostTimeline,
    upload.savedRecord.replayBoostTimeline,
    "the uploaded record retained the run's boost timeline");

  // The endpoint lookup above is not enough: open the actual leaderboard
  // replay in profile two and compare states emitted by its WebGL worker.
  await waitFor(second.client,
    `document.body.innerText.includes(${JSON.stringify(upload.nickname)})`,
    "the uploaded record in the selected track's leaderboard");
  await waitFor(
    second.client,
    `(() => {
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      const rows = document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main",
      );
      return !leaderboard?.querySelector("#polytrack-leaderboard-boost-filter select") &&
        rows.length === ${replayApi ? 3 : 1} &&
        [...rows].every((row) => {
          return !row.hasAttribute("data-polytrack-boost-status") &&
            !row.querySelector(".polytrack-boost-status");
        });
    })()`,
    "public leaderboard rows do not display replay boost classifications",
  );
  await unlockCheatMenu(second.client);
  assert.equal(
    await second.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status')?.hidden",
    ),
    true,
    "the in-playback status panel stays hidden until Watch starts",
  );
  const replaySelection = await second.client.evaluate(`(async () => {
    const nickname = ${JSON.stringify(upload.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) return { selected: false, reason: "record entry was not found" };
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch) return { selected: false, reason: "Watch control was not found" };
    const disabled = Boolean(watch.disabled);
    watch.click();
    return { selected: true, disabled };
  })()`);
  assert.equal(replaySelection.selected, true,
    `the uploaded leaderboard record could not be selected: ${JSON.stringify(replaySelection)}`);
  assert.equal(replaySelection.disabled, false,
    "the Watch control remained disabled after selecting the uploaded record");
  await waitForReplayStatus(
    second.client,
    `(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      return status && !status.hidden && /BOOSTED/.test(status.textContent);
    })()`,
    "the watched boosted replay status",
  );
  await second.client.call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(second.client, "window.__polytrackWebglAvailable === true", "replay WebGL context");
  await waitFor(
    second.client,
    `window.__polytrackWebglStates.some((state) =>
      window.__polytrackReplayCarIds.includes(state.carId) &&
      state.finishFrame !== null)`,
    "boosted leaderboard replay progress to reach the finish",
  );
  assert.ok(await second.client.evaluate("window.__polytrackFixtureLoads > 0"),
    "the replay profile loaded the map fixture with the newer community part");
  await waitFor(
    second.client,
    "window.__polytrackReplayLoadingFrames.some((frame) => frame > 0)",
    "boosted replay loading progress to advance beyond 0%",
  );
  const replayStates = await second.client.evaluate("window.__polytrackWebglStates");
  const replayCarIds = await second.client.evaluate("window.__polytrackReplayCarIds");
  assert.ok(replayCarIds.length > 0, "leaderboard replay did not create a replay car");
  const replayCarStates = replayStates.filter((state) => replayCarIds.includes(state.carId));
  assert.ok(replayCarStates.length > 1,
    "boosted replay worker emitted advancing simulation states");
  assert.ok(replayCarStates.some((state) => state.frame > 0),
    "boosted replay progress advanced beyond its initial frame");
  const recordedCheckpoint = run.states.find((state) => state.checkpoint > 0);
  const replayCheckpoint = replayCarStates.find((state) => state.checkpoint > 0);
  assert.ok(recordedCheckpoint, "the recorded run emitted no checkpoint position");
  assert.ok(replayCheckpoint, "the leaderboard replay emitted no checkpoint position");
  assert.equal(
    replayCheckpoint.frame,
    recordedCheckpoint.frame,
    "leaderboard replay checkpoint frame differs from recorded run",
  );
  assert.deepEqual(
    run.finish.finishFrame,
    replayCarStates.find((state) => state.finishFrame !== null)?.finishFrame,
    "leaderboard replay finish frame differs from recorded run",
  );
  assert.deepEqual(
    recordedCheckpoint.position,
    replayCheckpoint.position,
    "leaderboard replay checkpoint position differs from recorded run",
  );
  const replayLoadingFrames = await second.client.evaluate(
    "window.__polytrackReplayLoadingFrames",
  );
  assert.ok(replayLoadingFrames.some((frame) => frame > 0),
    "the boosted replay remained at 0% loading progress");
  assert.ok(Math.max(...replayLoadingFrames) >= run.finish.finishFrame,
    "the boosted replay did not load through its recorded finish frame");
  await waitFor(
    second.client,
    "document.getElementById('polytrack-cheat-replay-status')?.hidden === true",
    "the boosted replay status to clear after playback ended",
  );

  const savedRecordAfterReplay = await first.client.evaluate(
    `localStorage.getItem(${JSON.stringify(upload.recordKey)})`,
  );
  assert.equal(savedRecordAfterReplay, upload.savedRecordValue,
    "watching the boosted replay did not change the saved local record");
});

test("ordinary WebGL leaderboard replay finishes with a newer community track part", {
  skip: !enabled,
  timeout: timeoutMs * 2 + 30_000,
}, async (t) => {
  const trackFixture = (await readFile(
    path.join(__dirname, "fixtures", "webgl-community-part.track"), "utf8",
  )).trim();
  const testTrackId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const replayApi = await createReplayTestApi();
  const firstProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-ordinary-run-"));
  const secondProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-ordinary-replay-"));
  const confirmedNormalProfile = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-confirmed-normal-replay-"),
  );
  const earlyExitProfile = await mkdtemp(path.join(os.tmpdir(), "polytrack-early-exit-"));
  const trackNavigationProfile = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-track-navigation-"),
  );
  const first = await launchProfile(firstProfile);
  let second;
  let confirmedNormal;
  let earlyExit;
  let trackNavigation;
  t.after(async () => {
    await Promise.all([
      first.close(), second?.close(), confirmedNormal?.close(), earlyExit?.close(),
      trackNavigation?.close(),
      replayApi.close(),
    ].filter(Boolean));
    await Promise.all([
      rm(firstProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(secondProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(confirmedNormalProfile, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      }),
      rm(earlyExitProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(trackNavigationProfile, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      }),
    ]);
  });

  await first.client.call("Page.enable");
  await first.client.call("Runtime.enable");
  await first.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(first.client);
  await unlockCheatMenu(first.client);
  assert.equal(
    await first.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status')?.hidden",
    ),
    true,
    "the replay status appeared before an ordinary Play session",
  );
  await first.client.evaluate(
    "document.getElementById('polytrack-cheat-close')?.click()",
  );
  await startSelectedTrack(first.client);
  await first.client.evaluate(
    "document.getElementById('polytrack-cheat-launcher')?.click()",
  );
  await waitFor(
    first.client,
    "document.querySelector('#polytrack-cheat-backdrop')?.hidden === false",
    "cheat menu during ordinary Play",
  );
  assert.equal(
    await first.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status')?.hidden",
    ),
    true,
    "ordinary Play showed a replay boost status",
  );
  await first.client.evaluate(
    "document.getElementById('polytrack-cheat-close')?.click()",
  );
  assert.ok(await first.client.evaluate("window.__polytrackFixtureLoads > 0"),
    "the first profile loaded the community-part map fixture");
  assert.equal(await first.client.evaluate("window.__polytrackWebglAvailable"), true,
    "Chromium did not provide a real WebGL context");
  const run = await driveToFinish(first.client);

  const saved = await first.client.evaluate(`(() => {
    const recordKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'));
    const profileKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_user_/.test(key));
    const record = recordKey && JSON.parse(localStorage.getItem(recordKey));
    const profile = profileKey && JSON.parse(localStorage.getItem(profileKey));
    if (!record || !profile) throw new Error("ordinary finished run was not saved locally");
    profile.nickname = "Ordinary WebGL Replay " + crypto.randomUUID().slice(0, 8);
    localStorage.setItem(profileKey, JSON.stringify(profile));
    return {
      recordKey,
      snapshot: {
        frames: record.frames,
        recording: record.recording,
        replayBoostSettings: record.replayBoostSettings ?? null,
        replayBoostTimeline: record.replayBoostTimeline ?? null,
      },
      token: profile.token,
      carStyle: profile.carStyle,
      nickname: profile.nickname,
    };
  })()`);
  assert.ok(Number.isSafeInteger(saved.snapshot.frames) && saved.snapshot.frames > 0,
    "the ordinary saved record has a valid race time");
  assert.ok(saved.snapshot.recording.length > 0,
    "the ordinary saved record contains a serialized replay");
  assert.equal(saved.snapshot.replayBoostSettings, null,
    "the ordinary saved record has no boost settings");
  assert.equal(saved.snapshot.replayBoostTimeline, null,
    "the ordinary saved record has no boost timeline");
  const upload = await first.client.evaluate(`(async () => {
    const values = ${JSON.stringify({
      version: "v6",
      userToken: saved.token,
      nickname: saved.nickname,
      carStyle: saved.carStyle,
      trackId: testTrackId,
      frames: String(saved.snapshot.frames),
      recording: saved.snapshot.recording,
      onlyVerified: "true",
    })};
    const response = await fetch("/api/v6/leaderboard", {
      method: "POST",
      body: new URLSearchParams(values),
    });
    if (!response.ok) throw new Error("ordinary leaderboard upload returned " + response.status);
    return { ...(await response.json()), trackId: values.trackId, nickname: values.nickname };
  })()`);
  assert.ok(Number.isSafeInteger(upload.uploadId),
    "the ordinary saved record was uploaded for a separate browser profile");

  const confirmedNormalValues = {
    version: "v6",
    userToken: `${saved.token}:confirmed-normal`,
    nickname: `Confirmed Normal WebGL Replay ${randomUUID().slice(0, 8)}`,
    carStyle: saved.carStyle,
    trackId: testTrackId,
    frames: String(saved.snapshot.frames),
    recording: saved.snapshot.recording,
    onlyVerified: "true",
    normalPhysicsConfirmed: "true",
  };
  const confirmedNormalUpload = await first.client.evaluate(`(async () => {
    const values = ${JSON.stringify(confirmedNormalValues)};
    const response = await fetch("/api/v6/leaderboard", {
      method: "POST",
      body: new URLSearchParams(values),
    });
    if (!response.ok) {
      throw new Error("confirmed-normal leaderboard upload returned " + response.status);
    }
    return { ...(await response.json()), nickname: values.nickname };
  })()`);
  assert.ok(Number.isSafeInteger(confirmedNormalUpload.uploadId),
    "the confirmed-normal replay was seeded in the leaderboard");

  second = await launchProfile(secondProfile);
  await second.client.call("Page.enable");
  await second.client.call("Runtime.enable");
  await second.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(second.client);
  const replay = await second.client.evaluate(`(async () => {
    const response = await fetch("/api/v6/recordings?ids=${upload.uploadId}");
    if (!response.ok) throw new Error("ordinary recording lookup returned " + response.status);
    const [record] = await response.json();
    if (!record || record.replayBoostSettings || record.replayBoostTimeline) {
      throw new Error("ordinary recording unexpectedly has replay boost metadata");
    }
    return record;
  })()`);
  assert.equal(replay.frames, saved.snapshot.frames);
  assert.equal(replay.replayBoostSettings, undefined);
  assert.equal(replay.replayBoostTimeline, undefined);
  assert.equal(replay.normalPhysicsConfirmed, undefined,
    "the unmarked replay stays unknown rather than inheriting its peer's confirmation");
  const confirmedNormalReplay = await second.client.evaluate(`(async () => {
    const response = await fetch(
      "/api/v6/recordings?ids=${confirmedNormalUpload.uploadId}",
    );
    if (!response.ok) {
      throw new Error("confirmed-normal recording lookup returned " + response.status);
    }
    const [record] = await response.json();
    return record;
  })()`);
  assert.equal(confirmedNormalReplay.normalPhysicsConfirmed, true,
    "the leaderboard recording retained normal-physics confirmation");
  assert.equal(confirmedNormalReplay.replayBoostSettings, undefined);
  assert.equal(confirmedNormalReplay.replayBoostTimeline, undefined);

  await waitFor(second.client,
    `document.body.innerText.includes(${JSON.stringify(upload.nickname)})`,
    "the ordinary record in the selected track's leaderboard");
  const phoneLayouts = await assertPhoneLeaderboardLayout(second.client);
  t.diagnostic(`Ordinary replay phone layouts: ${JSON.stringify(phoneLayouts)}`);
  await second.client.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await unlockCheatMenu(second.client);
  assert.equal(
    await second.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status')?.hidden",
    ),
    true,
    "track browsing showed a replay boost status before watching the unmarked record",
  );
  const replaySelection = await second.client.evaluate(`(() => {
    const nickname = ${JSON.stringify(upload.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) return { selected: false, reason: "record entry was not found" };
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch) return { selected: false, reason: "Watch control was not found" };
    const disabled = Boolean(watch.disabled);
    watch.click();
    return { selected: true, disabled };
  })()`);
  assert.equal(replaySelection.selected, true,
    `the ordinary leaderboard record could not be selected: ${JSON.stringify(replaySelection)}`);
  assert.equal(replaySelection.disabled, false,
    "the Watch control remained disabled after selecting the ordinary record");
  await waitForReplayStatus(
    second.client,
    `(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      return status && !status.hidden && /UNKNOWN/.test(status.textContent);
    })()`,
    "the watched unmarked replay status",
  );
  await second.client.call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.match(
    await second.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status').textContent",
    ),
    /no saved boost data/i,
    "the unmarked replay explains why its boost status is unknown",
  );
  await waitFor(second.client, "window.__polytrackWebglAvailable === true",
    "ordinary replay WebGL context");
  await waitFor(
    second.client,
    `window.__polytrackWebglStates.some((state) =>
      window.__polytrackReplayCarIds.includes(state.carId) &&
      state.finishFrame !== null)`,
    "ordinary leaderboard replay progress to reach the finish",
  );
  assert.ok(await second.client.evaluate("window.__polytrackFixtureLoads > 0"),
    "the replay profile loaded the fixture containing the newer track part");
  const replayStates = await second.client.evaluate("window.__polytrackWebglStates");
  const replayCarIds = await second.client.evaluate("window.__polytrackReplayCarIds");
  const replayCarStates = replayStates.filter((state) => replayCarIds.includes(state.carId));
  assert.ok(replayCarStates.length > 1,
    "the ordinary replay worker emitted advancing simulation states");
  assert.ok(replayCarStates.some((state) => state.frame > 0),
    "ordinary replay progress advanced beyond its initial frame");
  assert.equal(
    replayCarStates.find((state) => state.finishFrame !== null)?.finishFrame,
    run.finish.finishFrame,
    "ordinary leaderboard replay finishes on the same frame as the saved run",
  );
  await waitFor(
    second.client,
    "document.getElementById('polytrack-cheat-replay-status')?.hidden === true",
    "the unmarked replay status to clear after playback ended",
  );

  confirmedNormal = await launchProfile(confirmedNormalProfile);
  await confirmedNormal.client.call("Page.enable");
  await confirmedNormal.client.call("Runtime.enable");
  await confirmedNormal.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(confirmedNormal.client);
  await waitFor(
    confirmedNormal.client,
    `document.body.innerText.includes(${JSON.stringify(confirmedNormalUpload.nickname)})`,
    "the confirmed-normal record in a fresh leaderboard view",
  );
  await unlockCheatMenu(confirmedNormal.client);
  assert.equal(
    await confirmedNormal.client.evaluate(
      "document.getElementById('polytrack-cheat-replay-status')?.hidden",
    ),
    true,
    "the in-playback status panel stays hidden until Watch starts",
  );
  assert.deepEqual(
    await confirmedNormal.client.evaluate(`(() => {
      const nickname = ${JSON.stringify(confirmedNormalUpload.nickname)};
      const leaderboard = document.querySelector(".track-info-ui .leaderboard-ui");
      const row = [...document.querySelectorAll(
        ".track-info-ui .leaderboard-ui .container button.main",
      )].find((entry) => entry.textContent.includes(nickname));
      return {
        filter: Boolean(leaderboard?.querySelector("#polytrack-leaderboard-boost-filter")),
        statusLabel: row?.querySelector(".polytrack-boost-status")?.textContent ?? null,
        statusAttribute: row?.getAttribute("data-polytrack-boost-status") ?? null,
      };
    })()`),
    { filter: false, statusLabel: null, statusAttribute: null },
    "no replay classification is shown on the public leaderboard",
  );

  const replayIdsBeforeConfirmedNormal = await confirmedNormal.client.evaluate(
    "window.__polytrackReplayCarIds.slice()",
  );
  const confirmedNormalSelection = await confirmedNormal.client.evaluate(`(() => {
    const nickname = ${JSON.stringify(confirmedNormalUpload.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) return { selected: false, reason: "confirmed-normal entry was not found" };
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch) return { selected: false, reason: "Watch control was not found" };
    const disabled = Boolean(watch.disabled);
    watch.click();
    return { selected: true, disabled };
  })()`);
  assert.equal(confirmedNormalSelection.selected, true,
    `the confirmed-normal leaderboard record could not be selected: ${JSON.stringify(confirmedNormalSelection)}`);
  assert.equal(confirmedNormalSelection.disabled, false,
    "the Watch control remained disabled for the confirmed-normal record");
  await waitForReplayStatus(
    confirmedNormal.client,
    `(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      return status && !status.hidden && /NOT BOOSTED/.test(status.textContent);
    })()`,
    "the watched confirmed-normal replay status",
  );
  await waitFor(confirmedNormal.client, "window.__polytrackWebglAvailable === true",
    "confirmed-normal replay WebGL context");
  await waitFor(
    confirmedNormal.client,
    `window.__polytrackReplayCarIds.some((id) =>
      !${JSON.stringify(replayIdsBeforeConfirmedNormal)}.includes(id))`,
    "the confirmed-normal replay worker to start",
  );
  const confirmedNormalReplayIds = await confirmedNormal.client.evaluate(
    `window.__polytrackReplayCarIds.filter((id) =>
      !${JSON.stringify(replayIdsBeforeConfirmedNormal)}.includes(id))`,
  );
  assert.ok(confirmedNormalReplayIds.length > 0,
    "Watch started a new WebGL replay worker for the confirmed-normal entry");
  await waitFor(
    confirmedNormal.client,
    `window.__polytrackWebglStates.some((state) =>
      ${JSON.stringify(confirmedNormalReplayIds)}.includes(state.carId) &&
      state.finishFrame !== null)`,
    "confirmed-normal leaderboard replay progress to reach the finish",
  );
  const confirmedNormalReplayStates = await confirmedNormal.client.evaluate(
    `window.__polytrackWebglStates.filter((state) =>
      ${JSON.stringify(confirmedNormalReplayIds)}.includes(state.carId))`,
  );
  assert.ok(confirmedNormalReplayStates.length > 1,
    "confirmed-normal replay worker emitted advancing simulation states");
  assert.equal(
    confirmedNormalReplayStates.find((state) => state.finishFrame !== null)?.finishFrame,
    saved.snapshot.frames,
    "the confirmed-normal replay reached its recorded finish frame in WebGL",
  );
  await waitFor(
    confirmedNormal.client,
    "document.getElementById('polytrack-cheat-replay-status')?.hidden === true",
    "the confirmed-normal replay status to clear after playback ended",
  );

  const preserved = await first.client.evaluate(`(() => {
    const record = JSON.parse(localStorage.getItem(${JSON.stringify(saved.recordKey)}));
    return {
      frames: record.frames,
      recording: record.recording,
      replayBoostSettings: record.replayBoostSettings ?? null,
      replayBoostTimeline: record.replayBoostTimeline ?? null,
    };
  })()`);
  assert.deepEqual(preserved, saved.snapshot,
    "watching the ordinary replay did not change its saved local record");

  earlyExit = await launchProfile(earlyExitProfile);
  await earlyExit.client.call("Page.enable");
  await earlyExit.client.call("Runtime.enable");
  await earlyExit.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(earlyExit.client);
  await waitFor(
    earlyExit.client,
    `document.body.innerText.includes(${JSON.stringify(upload.nickname)})`,
    "the uploaded record for the early-exit replay",
  );
  await unlockCheatMenu(earlyExit.client);
  const earlyExitResult = await earlyExit.client.evaluate(`(async () => {
    const nickname = ${JSON.stringify(upload.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) throw new Error("early-exit replay entry was not found");
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch || watch.disabled) throw new Error("early-exit Watch control is unavailable");
    watch.click();

    const status = document.getElementById("polytrack-cheat-replay-status");
    if (!status) throw new Error("replay status element was not found");
    const exitResult = await new Promise((resolve, reject) => {
      let settled = false;
      let poll;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        clearInterval(poll);
        callback(value);
      };
      const observer = new MutationObserver(checkForActiveReplay);
      const timeout = setTimeout(() => finish(
        reject,
        new Error("no active replay status was available to exit"),
      ), 20_000);
      function checkForActiveReplay() {
        if (status.hidden || !/UNKNOWN/.test(status.textContent)) return;
        const replayIds = window.__polytrackReplayCarIds ?? [];
        const replayStates = (window.__polytrackWebglStates ?? [])
          .filter((state) => replayIds.includes(state.carId));
        if (!replayIds.length) return;
        if (replayStates.some((state) => state.finishFrame !== null)) {
          finish(reject, new Error("replay finished before the early-exit action"));
          return;
        }
        const statusBeforeExit = status.textContent;
        const toolbar = document.createElement("div");
        toolbar.className = "game-toolbar-ui";
        const exit = document.createElement("button");
        exit.className = "button";
        const icon = document.createElement("img");
        icon.className = "button-icon";
        icon.setAttribute("src", "images/quit.svg");
        exit.appendChild(icon);
        toolbar.appendChild(exit);
        document.body.appendChild(toolbar);
        exit.click();
        const statusHiddenImmediately = status.hidden;
        toolbar.remove();
        finish(resolve, {
          statusBeforeExit,
          replayIds,
          replayStarted: true,
          replayFinishedBeforeExit: false,
          statusHiddenImmediately,
        });
      }
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      poll = setInterval(checkForActiveReplay, 1);
      checkForActiveReplay();
    });
    return exitResult;
  })()`);
  assert.match(
    earlyExitResult.statusBeforeExit,
    /UNKNOWN/,
    "the watched replay status was visible before exiting Watch",
  );
  assert.ok(earlyExitResult.replayIds.length > 0,
    "the browser started a replay before exiting Watch");
  assert.equal(earlyExitResult.replayStarted, true);
  assert.equal(earlyExitResult.replayFinishedBeforeExit, false,
    "the early-exit action happened before replay completion");
  assert.equal(earlyExitResult.statusHiddenImmediately, true,
    "exiting Watch did not hide replay status in the same browser action");
  const earlyExitStatus = await earlyExit.client.evaluate(`(() => {
    const status = document.getElementById("polytrack-cheat-replay-status");
    return { hidden: status?.hidden ?? null, text: status?.textContent ?? null };
  })()`);
  assert.equal(
    earlyExitStatus.hidden,
    true,
    "the real browser replay status remained visible after exiting Watch",
  );
  const statusAfterMenuReopen = await earlyExit.client.evaluate(`(() => {
    const status = document.getElementById("polytrack-cheat-replay-status");
    const menu = document.getElementById("polytrack-cheat-backdrop");
    const launcher = document.getElementById("polytrack-cheat-launcher");
    if (!status || !menu || !launcher) {
      throw new Error("cheat menu replay status controls were not found");
    }
    document.getElementById("polytrack-cheat-close")?.click();
    const menuClosed = menu.hidden;
    launcher.click();
    return {
      menuClosed,
      menuReopened: !menu.hidden,
      statusHidden: status.hidden,
    };
  })()`);
  assert.equal(
    statusAfterMenuReopen.menuClosed,
    true,
    "the cheat menu closed after leaving Watch",
  );
  assert.equal(
    statusAfterMenuReopen.menuReopened,
    true,
    "the cheat menu reopened without starting another replay",
  );
  assert.equal(
    statusAfterMenuReopen.statusHidden,
    true,
    "reopening the real cheat menu did not restore the exited replay status",
  );

  trackNavigation = await launchProfile(trackNavigationProfile);
  await trackNavigation.client.call("Page.enable");
  await trackNavigation.client.call("Runtime.enable");
  await trackNavigation.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId, undefined, replayApi.url),
  });
  await openTrack(trackNavigation.client);
  await waitFor(
    trackNavigation.client,
    `document.body.innerText.includes(${JSON.stringify(upload.nickname)})`,
    "the uploaded record for the track-navigation replay",
  );
  await unlockCheatMenu(trackNavigation.client);
  const navigationReplaySelected = await trackNavigation.client.evaluate(`(() => {
    const nickname = ${JSON.stringify(upload.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) return false;
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch || watch.disabled) return false;
    watch.click();
    return true;
  })()`);
  assert.equal(navigationReplaySelected, true,
    "the leaderboard replay could not be started for track navigation");
  await waitForReplayStatus(
    trackNavigation.client,
    `(() => {
      const status = document.getElementById("polytrack-cheat-replay-status");
      return status && !status.hidden && /UNKNOWN/.test(status.textContent);
    })()`,
    "the active replay status before track navigation",
  );
  const trackNavigationResult = await trackNavigation.client.evaluate(`(() => {
    const status = document.getElementById("polytrack-cheat-replay-status");
    const toolbar = document.querySelector(".game-toolbar-ui .button-container");
    if (!status || status.hidden || !toolbar) {
      throw new Error("the active replay or game toolbar was not available");
    }
    const replayIds = window.__polytrackReplayCarIds ?? [];
    const replayStates = (window.__polytrackWebglStates ?? [])
      .filter((state) => replayIds.includes(state.carId));
    if (replayStates.some((state) => state.finishFrame !== null)) {
      throw new Error("the replay finished before track navigation");
    }
    let nextTrackButton = [...toolbar.querySelectorAll(".button")]
      .find((button) =>
        button.querySelector("img.button-icon")?.getAttribute("src") ===
        "images/play.svg");
    const usedGameNextTrack = Boolean(nextTrackButton);
    if (!nextTrackButton) {
      nextTrackButton = document.createElement("button");
      nextTrackButton.className = "button";
      const icon = document.createElement("img");
      icon.className = "button-icon";
      icon.setAttribute("src", "images/play.svg");
      nextTrackButton.appendChild(icon);
      nextTrackButton.appendChild(document.createTextNode("Next Track"));
      toolbar.appendChild(nextTrackButton);
    }
    nextTrackButton.click();
    return {
      statusHiddenImmediately: status.hidden,
      previousStatusText: status.textContent,
      usedGameNextTrack,
    };
  })()`);
  assert.equal(
    /UNKNOWN/.test(trackNavigationResult.previousStatusText),
    true,
    "the source replay's status was visible before changing tracks",
  );
  assert.equal(
    trackNavigationResult.statusHiddenImmediately,
    true,
    "changing tracks did not immediately clear the active replay status",
  );
  t.diagnostic(
    trackNavigationResult.usedGameNextTrack
      ? "The active replay was cleared through the game's Next Track control."
      : "The active replay was cleared through a browser-simulated Next Track control.",
  );
});

async function verifyOrdinaryReplayOnCommunityPart(
  t,
  { fixtureName, partId, partName },
) {
  const [{ patchPolytrackMainBundle }, fixtureSource] = await Promise.all([
    import("../main-bundle-startup-patch.js"),
    readFile(path.join(__dirname, "fixtures", fixtureName), "utf8"),
  ]);
  const trackFixture = fixtureSource.trim();
  globalThis.self ??= globalThis;
  globalThis.window ??= globalThis;
  const bundle = patchPolytrackMainBundle(
    await readFile(path.join(__dirname, "../public/main.bundle.js"), "utf8"),
  );
  const requireModule = loadBundleModules(bundle);
  const parsers = [requireModule(5440).U, requireModule(9681).U];
  const fixtureTrack = parseTrack(trackFixture, parsers);
  assert.ok(fixtureTrack, "the community-part fixture decodes as a track");
  const fixturePartIds = new Set();
  fixtureTrack.trackData.forEachPart((_x, _y, _z, type) => fixturePartIds.add(type));
  assert.ok(fixturePartIds.has(partId),
    `the browser fixture contains the project-added ${partName} part`);
  assert.ok(fixtureTrack.trackData.hasStartingPoint(),
    `the ${partName} fixture retains its finishable start`);

  const testTrackId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const runProfileDirectory = await mkdtemp(
    path.join(os.tmpdir(), `polytrack-${partName.toLowerCase()}-run-`),
  );
  const replayProfileDirectory = await mkdtemp(
    path.join(os.tmpdir(), `polytrack-${partName.toLowerCase()}-replay-`),
  );
  const first = await launchProfile(runProfileDirectory);
  let second;
  t.after(async () => {
    await Promise.all([first.close(), second?.close()].filter(Boolean));
    await Promise.all([
      rm(runProfileDirectory, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      }),
      rm(replayProfileDirectory, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      }),
    ]);
  });

  await first.client.call("Page.enable");
  await first.client.call("Runtime.enable");
  await first.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId),
  });
  await startTrack(first.client);
  assert.ok(await first.client.evaluate("window.__polytrackFixtureLoads > 0"),
    `the unboosted run did not load the ${partName} fixture`);
  assert.equal(await first.client.evaluate("window.__polytrackWebglAvailable"), true,
    "Chromium did not provide a real WebGL context");

  const run = await driveToFinish(first.client, "ordinary unboosted");
  assert.ok(run.finish, "the ordinary browser run reached the finish");
  const expectedReplayFrames = run.finish.finishFrame;
  assert.ok(Number.isSafeInteger(expectedReplayFrames) && expectedReplayFrames > 0,
    "the ordinary record has a valid finish frame for replay progress");
  const saved = await first.client.evaluate(`(() => {
    const recordKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'));
    const profileKey = Object.keys(localStorage).find((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_user_/.test(key));
    const value = recordKey && localStorage.getItem(recordKey);
    const record = value && JSON.parse(value);
    const profile = profileKey && JSON.parse(localStorage.getItem(profileKey));
    if (!record || !profile) {
      throw new Error("the finished ordinary run was not saved to local storage");
    }
    if (record.replayBoostSettings != null || record.replayBoostTimeline != null) {
      throw new Error("the ordinary run unexpectedly contains replay boost metadata");
    }
    profile.nickname = "Replay ${partName} " + crypto.randomUUID().slice(0, 8);
    localStorage.setItem(profileKey, JSON.stringify(profile));
    return {
      key: recordKey,
      value,
      frames: record.frames,
      recording: record.recording,
      nickname: profile.nickname,
      token: profile.token,
      carStyle: profile.carStyle,
    };
  })()`);
  assert.ok(Number.isSafeInteger(saved.frames) && saved.frames > 0,
    "the saved ordinary run has a valid finish time");
  assert.ok(saved.recording.length > 0, "the saved ordinary run has replay controls");

  const upload = await first.client.evaluate(`(async () => {
    const form = new URLSearchParams({
      version: "v6",
      userToken: ${JSON.stringify(saved.token)},
      nickname: ${JSON.stringify(saved.nickname)},
      carStyle: ${JSON.stringify(saved.carStyle)},
      trackId: ${JSON.stringify(testTrackId)},
      frames: ${JSON.stringify(String(saved.frames))},
      recording: ${JSON.stringify(saved.recording)},
      onlyVerified: "true",
    });
    const response = await fetch("/api/v6/leaderboard", { method: "POST", body: form });
    if (!response.ok) throw new Error("ordinary leaderboard upload returned " + response.status);
    return response.json();
  })()`);
  assert.ok(Number.isSafeInteger(upload.uploadId),
    `ordinary ${partName} leaderboard upload did not return an id`);

  second = await launchProfile(replayProfileDirectory);
  await second.client.call("Page.enable");
  await second.client.call("Runtime.enable");
  await second.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture, testTrackId),
  });
  await openTrack(second.client);
  const replay = await second.client.evaluate(`(async () => {
    const response = await fetch("/api/v6/recordings?ids=${upload.uploadId}");
    if (!response.ok) throw new Error("ordinary recording lookup returned " + response.status);
    const [record] = await response.json();
    return record;
  })()`);
  assert.ok(replay, "the uploaded ordinary recording is available to watch");
  assert.equal(replay.replayBoostSettings ?? null, null,
    "the uploaded ordinary replay has no boost settings");
  assert.equal(replay.replayBoostTimeline ?? null, null,
    "the uploaded ordinary replay has no boost timeline");

  const leaderboard = await second.client.evaluate(`(async () => {
    const query = new URLSearchParams({
      version: "v6",
      trackId: ${JSON.stringify(testTrackId)},
      skip: "0",
      amount: "20",
      onlyVerified: "false",
    });
    const response = await fetch("/api/v6/leaderboard?" + query);
    if (!response.ok) throw new Error("ordinary leaderboard lookup returned " + response.status);
    return response.json();
  })()`);
  assert.ok(
    leaderboard.entries.some((entry) => entry.nickname === saved.nickname),
    `the uploaded ${partName} record was absent from the leaderboard: ` +
      JSON.stringify(leaderboard.entries.map(({ nickname, verifiedState }) => ({
        nickname, verifiedState,
      }))),
  );

  await waitFor(
    second.client,
    `document.body.innerText.includes(${JSON.stringify(saved.nickname)})`,
    `the ordinary ${partName} recording in the leaderboard`,
  );
  const replaySelection = await second.client.evaluate(`(() => {
    const nickname = ${JSON.stringify(saved.nickname)};
    const entry = [...document.querySelectorAll("*")].find((element) =>
      element.children.length === 0 && element.textContent?.trim() === nickname);
    if (!entry) return { selected: false, reason: "record entry was not found" };
    entry.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    const watch = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => (element.innerText || "").trim() === "Watch");
    if (!watch) return { selected: false, reason: "Watch control was not found" };
    const disabled = Boolean(watch.disabled);
    watch.click();
    return { selected: true, disabled };
  })()`);
  assert.equal(replaySelection.selected, true,
    `the ordinary ${partName} record could not be selected: ${JSON.stringify(replaySelection)}`);
  assert.equal(replaySelection.disabled, false,
    `the Watch control remained disabled for the ordinary ${partName} replay`);

  await waitFor(
    second.client,
    `window.__polytrackWebglStates.some((state) =>
      window.__polytrackReplayCarIds.includes(state.carId) &&
      state.finishFrame !== null)`,
    `the ordinary ${partName} replay to reach its finish`,
  );
  // The client derives its loader percentage from loaded replay frames divided
  // by the recorded frame count. Capture those worker frames directly so a
  // fast headless replay cannot skip the rendered percentage between polls.
  await waitFor(
    second.client,
    "window.__polytrackReplayLoadingFrames.some((frame) => frame > 0)",
    "ordinary replay loading progress to advance beyond 0%",
  );
  const result = await second.client.evaluate(`(() => {
    const replayIds = window.__polytrackReplayCarIds;
    const states = window.__polytrackWebglStates.filter((state) =>
      replayIds.includes(state.carId));
    const loadingFrames = window.__polytrackReplayLoadingFrames;
    const maxLoadedFrame = loadingFrames.reduce(
      (maximum, frame) => Math.max(maximum, frame), 0,
    );
    return {
      replayIds,
      replayStateCount: states.length,
      replayFinishFrame:
        states.find((state) => state.finishFrame !== null)?.finishFrame ?? null,
      firstLoadedFrame: loadingFrames[0] ?? null,
      maxLoadedFrame,
      loadingProgress: Math.min(
        maxLoadedFrame / ${JSON.stringify(expectedReplayFrames)},
        1,
      ),
      fixtureLoads: window.__polytrackFixtureLoads,
    };
  })()`);
  assert.ok(result.firstLoadedFrame > 0 && result.loadingProgress > 0,
    "the ordinary replay remained at 0% loading progress");
  assert.ok(result.loadingProgress >= 1,
    "the ordinary replay did not load through its recorded finish frame");
  assert.ok(result.replayIds.length > 0, "Watch did not create a replay car");
  assert.ok(result.replayStateCount > 0,
    `the ordinary ${partName} replay worker emitted no states`);
  assert.equal(result.replayFinishFrame, expectedReplayFrames,
    `the ordinary ${partName} replay reached the saved finish frame`);
  assert.ok(result.fixtureLoads > 0,
    `the replay profile did not load the ${partName} fixture`);
  const savedRecord = await first.client.evaluate(
    `localStorage.getItem(${JSON.stringify(saved.key)})`,
  );
  assert.equal(savedRecord, saved.value,
    "watching the ordinary replay changed the original saved record");
}

for (const scenario of [
  {
    fixtureName: "webgl-community-part.track",
    partId: 188,
    partName: "BlockOuterCorner",
  },
  {
    fixtureName: "webgl-plane-corner.track",
    partId: 189,
    partName: "PlaneCorner",
  },
]) {
  test(
    `ordinary replay on a community map with project-added ${scenario.partName} advances beyond 0%`,
    {
      skip: !enabled,
      timeout: timeoutMs * 2 + 30_000,
    },
    async (t) => verifyOrdinaryReplayOnCommunityPart(t, scenario),
  );
}


test("The Eldritch Estate can be re-entered twice without losing its local record", {
  skip: !enabled,
  timeout: timeoutMs * 5 + 60_000,
}, async (t) => {
  const [{ communityTrackImports }, trackFixture] = await Promise.all([
    import("../community-track-imports.js"),
    readFile(path.join(__dirname, "fixtures", "webgl-straight.track"), "utf8"),
  ]);
  const eldritchTrack = communityTrackImports.find(
    ({ name }) => name === "The Eldritch Estate",
  );
  assert.ok(eldritchTrack, "The Eldritch Estate is in the community registry");

  const fixtureId = createHash("sha256")
    .update(`${trackFixture}:${randomUUID()}`)
    .digest("hex");
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "polytrack-eldritch-reentry-"));
  const browser = await launchProfile(profileDirectory);
  t.after(async () => {
    await browser.close();
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWorkerProbe(trackFixture.trim(), fixtureId),
  });

  // Generate a real, valid local recording, then seed it under the community
  // track's canonical ID before running the re-entry sequence.
  await startTrack(browser.client);
  assert.ok(await browser.client.evaluate("window.__polytrackFixtureLoads > 0"),
    "the completed seed run loaded its test track fixture");
  assert.equal(await browser.client.evaluate("window.__polytrackWebglAvailable"), true,
    "Chromium did not provide a real WebGL context");
  await enableBoost(browser.client);
  await driveToFinish(browser.client);
  await waitFor(
    browser.client,
    `Object.keys(localStorage).some((key) =>
      /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key) &&
      localStorage.getItem(key)?.includes('"recording"'))`,
    "the seed run to be saved locally",
  );
  const seeded = await seedEldritchRecordFromCompletedRun(
    browser.client,
    eldritchTrack.id,
  );
  assert.ok(Number.isSafeInteger(seeded.frames) && seeded.frames > 0,
    "the seeded personal best has a valid race time");
  assert.ok(seeded.recording.length > 0,
    "the seeded personal best contains a serialized recording");

  await openTrack(browser.client, "The Eldritch Estate");
  await assertNoTrackLoadError(browser.client, "initial selection");
  await assertRecordUnchanged(
    browser.client, seeded.key, seeded.value, seeded.recording, "after startup",
  );

  for (let entry = 1; entry <= 3; entry += 1) {
    await assertNoTrackLoadError(browser.client, entry);
    await driveForMovingStates(browser.client, "The Eldritch Estate", entry);
    await assertRecordUnchanged(
      browser.client, seeded.key, seeded.value, seeded.recording,
      `during entry ${entry}`,
    );

    if (entry < 3) {
      await exitToTrackSelection(browser.client, entry);
      await assertNoTrackLoadError(browser.client, `exit after entry ${entry}`);
      await assertRecordUnchanged(
        browser.client, seeded.key, seeded.value, seeded.recording,
        `after exiting entry ${entry}`,
      );
      await selectTrackFromPicker(browser.client, "The Eldritch Estate");
    }
  }
});

test("the weekly featured community card shows its first-place driver and countdown", {
  skip: !enabled,
  timeout: timeoutMs,
}, async (t) => {
  const initialResponse = await fetch(
    new URL("/api/v6/trackOfTheWeek?version=0.6.3", browserUrl),
  );
  assert.equal(initialResponse.status, 200, "the weekly API is available");
  const initialPayload = await initialResponse.json();
  const { getTrackOfTheWeek } = await import(
    "../../api-server/src/lib/track-of-the-week.ts"
  );
  const nextPayload = getTrackOfTheWeek(
    new Date(initialPayload.current.endTime),
  );
  assert.notEqual(
    initialPayload.current.trackId,
    nextPayload.current.trackId,
    "the featured map changes at the next UTC Monday",
  );

  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-weekly-feature-"),
  );
  const browser = await launchProfile(profileDirectory);
  t.after(async () => {
    await browser.close();
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWeeklyRolloverProbe(initialPayload, nextPayload),
  });
  await browser.client.call("Page.navigate", { url: browserUrl });
  await waitFor(
    browser.client,
    "window.__polytrackStartupReady === true",
    "PolyTrack startup",
  );
  await waitFor(
    browser.client,
    "!document.body?.innerText.includes('Loading...')",
    "PolyTrack startup resources",
  );

  const openedPicker = await browser.client.evaluate(`(() => {
    const play = [...document.querySelectorAll("button")]
      .find((button) => button.innerText.trim() === "Play" && button.offsetWidth > 0);
    if (!play) return false;
    play.click();
    return true;
  })()`);
  assert.equal(openedPicker, true, "the Play control opens the track picker");
  await waitFor(
    browser.client,
    "document.body?.innerText.includes('Community tracks')",
    "the Community Tracks tab",
  );

  const openedCommunity = await browser.client.evaluate(`(() => {
    const tab = document.querySelector(
      ".track-selection-ui .category-container > .button.community",
    );
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  assert.equal(openedCommunity, true, "the Community Tracks tab is available");
  await waitFor(
    browser.client,
    `(() => document.querySelector(
      ".track-selection-ui .tracks-container.open .track.track-of-the-week",
    )?.getAttribute("data-polytrack-weekly-track"))()`,
    "the weekly featured card",
  );
  await waitFor(
    browser.client,
    `(() => {
      const image = document.querySelector(
        ".track-of-the-week > .button > img.thumbnail",
      );
      return image?.complete && image.naturalWidth > 0;
    })()`,
    "the featured map thumbnail",
    15_000,
  );
  await waitFor(
    browser.client,
    `document.querySelector(
      ".track.track-of-the-week [data-polytrack-weekly-first-place]",
    )?.textContent?.includes("Weekly driver")`,
    "the featured map's first-place driver",
  );

  const featuredCard = await browser.client.evaluate(`(() => {
    const container = document.querySelector(
      ".track-selection-ui .tracks-container.open",
    );
    const card = container?.querySelector(".track.track-of-the-week");
    return {
      trackId: card?.getAttribute("data-polytrack-weekly-track"),
      week: card?.getAttribute("data-polytrack-weekly-week"),
      title: card?.querySelector(".track-of-the-week-info .title")?.textContent,
      selectedTitle: window.__polytrackCurrentWeeklyTrack?.name,
      selectedTrackId: window.__polytrackCurrentWeeklyTrack?.id,
      firstPlace: card?.querySelector("[data-polytrack-weekly-first-place]")?.textContent,
      countdown: card?.querySelector(".time-remaining")?.textContent,
      thumbnailWidth: card?.querySelector("img.thumbnail")?.naturalWidth,
      firstItem: container?.firstElementChild?.textContent?.trim(),
      cardCount: container?.querySelectorAll(
        ".track.track-of-the-week[data-polytrack-weekly-track]",
      ).length,
      oldBadgeCount: document.querySelectorAll(".polytrack-weekly-badge").length,
    };
  })()`);
  assert.equal(featuredCard.trackId, featuredCard.selectedTrackId);
  assert.ok(featuredCard.week, "the card has a UTC week key");
  assert.equal(featuredCard.title, featuredCard.selectedTitle);
  assert.equal(
    featuredCard.firstPlace,
    `1st place: Weekly driver ${featuredCard.trackId.slice(0, 8)} #1`,
  );
  const firstPlaceRequest = await browser.client.evaluate(
    "window.__polytrackWeeklyLeaderboardRequests.at(-1)",
  );
  assert.equal(firstPlaceRequest.trackId, featuredCard.trackId);
  assert.equal(firstPlaceRequest.onlyVerified, "true");
  assert.equal(firstPlaceRequest.amount, "1");
  assert.ok(featuredCard.countdown, "the card shows a live countdown");
  assert.ok(featuredCard.thumbnailWidth > 0, "the card shows its map thumbnail");
  assert.equal(featuredCard.firstItem, "Track of the Week");
  assert.equal(featuredCard.cardCount, 1);
  assert.equal(featuredCard.oldBadgeCount, 0);

  const navigationToken = await browser.client.evaluate(
    "window.__polytrackWeeklyDocumentToken",
  );
  const weekExpiry = Date.parse(initialPayload.current.endTime);
  await browser.client.evaluate(
    `window.__polytrackSetTestTime(${weekExpiry - 1})`,
  );
  assert.equal(
    await browser.client.evaluate("window.__polytrackWeeklyRequestCount"),
    1,
    "the current week remains featured just before its UTC expiry",
  );

  await browser.client.evaluate(
    `window.__polytrackSetTestTime(${weekExpiry})`,
  );
  await waitFor(
    browser.client,
    "window.__polytrackWeeklyRequestCount === 2",
    "the weekly API refresh at Monday 00:00 UTC",
  );
  await waitFor(
    browser.client,
    `(() => document.querySelector(
      ".track-selection-ui .tracks-container.open .track.track-of-the-week",
    )?.getAttribute("data-polytrack-weekly-track") ===
      ${JSON.stringify(nextPayload.current.trackId)})()`,
    "the picker highlight for the new UTC week",
  );
  await waitFor(
    browser.client,
    `document.querySelector(
      ".track.track-of-the-week [data-polytrack-weekly-first-place]",
    )?.textContent === ${JSON.stringify(
      `1st place: Weekly driver ${nextPayload.current.trackId.slice(0, 8)} #2`,
    )}`,
    "the new week's first-place driver",
  );

  const nextFeaturedCard = await browser.client.evaluate(`(() => {
    const container = document.querySelector(
      ".track-selection-ui .tracks-container.open",
    );
    const card = container?.querySelector(".track.track-of-the-week");
    return {
      trackId: card?.getAttribute("data-polytrack-weekly-track"),
      week: card?.getAttribute("data-polytrack-weekly-week"),
      title: card?.querySelector(".track-of-the-week-info .title")?.textContent,
      firstPlace: card?.querySelector("[data-polytrack-weekly-first-place]")?.textContent,
      selectedTrackId: window.__polytrackCurrentWeeklyTrack?.id,
      firstItem: container?.firstElementChild?.textContent?.trim(),
      cardCount: container?.querySelectorAll(
        ".track.track-of-the-week[data-polytrack-weekly-track]",
      ).length,
      navigationToken: window.__polytrackWeeklyDocumentToken,
    };
  })()`);
  assert.equal(nextFeaturedCard.trackId, nextPayload.current.trackId);
  assert.equal(nextFeaturedCard.selectedTrackId, nextPayload.current.trackId);
  assert.equal(nextFeaturedCard.week, nextPayload.serverTime.slice(0, 10));
  assert.equal(nextFeaturedCard.title, nextPayload.current.name);
  assert.equal(
    nextFeaturedCard.firstPlace,
    `1st place: Weekly driver ${nextPayload.current.trackId.slice(0, 8)} #2`,
  );
  assert.equal(nextFeaturedCard.firstItem, "Track of the Week");
  assert.equal(nextFeaturedCard.cardCount, 1);
  assert.equal(nextFeaturedCard.navigationToken, navigationToken);

  await browser.client.evaluate(
    `document.dispatchEvent(new Event("visibilitychange"))`,
  );
  await waitFor(
    browser.client,
    `document.querySelector(
      ".track.track-of-the-week [data-polytrack-weekly-first-place]",
    )?.textContent === ${JSON.stringify(
      `1st place: Weekly driver ${nextPayload.current.trackId.slice(0, 8)} #3`,
    )}`,
    "the leader refresh when the browser returns to the foreground",
  );

  const openedFeaturedMap = await browser.client.evaluate(`(() => {
    const button = document.querySelector(
      ".track.track-of-the-week > .button",
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openedFeaturedMap, true, "the featured card is clickable");
  await waitFor(
    browser.client,
    `(() => document.querySelector(".track-info-ui")?.innerText.includes(
      ${JSON.stringify(nextPayload.current.name)},
    ))()`,
    "the selected featured map details",
  );
});

test("registered community tracks using 0.6.1 or 0.6.3 parts drive under WebGL", {
  skip: !enabled,
  timeout: timeoutMs * 20 + 60_000,
}, async (t) => {
  const [{ patchPolytrackMainBundle }, rawBundle] = await Promise.all([
    import("../main-bundle-startup-patch.js"),
    readFile(path.join(__dirname, "../public/main.bundle.js"), "utf8"),
  ]);
  globalThis.self ??= globalThis;
  globalThis.window ??= globalThis;
  const bundle = patchPolytrackMainBundle(rawBundle);
  const requireModule = loadBundleModules(bundle);
  const registeredTracks = findRegisteredTracksUsingPartIds(
    bundle,
    requireModule,
    [188, 189],
  );
  const tracksToDrive = registeredTracks.filter(
    ({ name, group }) =>
      name !== "The Eldritch Estate" &&
      ["0.6.1", "0.6.3"].includes(group),
  );
  assert.ok(tracksToDrive.length > 0,
    "the community registry includes tracks using 0.6.1 or 0.6.3 part IDs");
  assert.ok(
    tracksToDrive.every(({ group }) => ["0.6.1", "0.6.3"].includes(group)),
    "every selected track is registered in a release group using the patched part IDs",
  );
  t.diagnostic(
    `Driving ${tracksToDrive.length} other 0.6.1 or 0.6.3 tracks: ` +
      tracksToDrive.map(({ name, partIds }) =>
        `${name} [${partIds.join(", ")}]`).join("; "),
  );

  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-community-drive-"),
  );
  const browser = await launchProfile(profileDirectory);
  t.after(async () => {
    await browser.close();
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createTrackDriveProbe(),
  });

  for (let index = 0; index < tracksToDrive.length; index += 1) {
    const track = tracksToDrive[index];
    await openTrack(browser.client, track.name);
    assert.equal(
      await browser.client.evaluate("window.__polytrackWebglAvailable"),
      true,
      "Chromium did not provide a real WebGL context",
    );
    await assertNoTrackLoadError(browser.client, `${track.name} selection`);
    await assertNoWorkerError(browser.client, track.name);
    await driveForMovingStates(browser.client, track.name, index + 1, 45);
    await assertNoWorkerError(browser.client, track.name);
  }
});

test("a Track of the Week outage leaves official and community tracks usable", {
  skip: !weeklyOutageEnabled,
  timeout: timeoutMs + 30_000,
}, async (t) => {
  const { communityTrackImports } = await import("../community-track-imports.js");
  const featuredTrack = communityTrackImports.find(
    ({ name }) => name === "The Eldritch Estate",
  );
  assert.ok(featuredTrack, "the community registry includes The Eldritch Estate");
  const serverTime = new Date();
  const daysUntilMonday = (8 - serverTime.getUTCDay()) % 7 || 7;
  const endTime = new Date(Date.UTC(
    serverTime.getUTCFullYear(),
    serverTime.getUTCMonth(),
    serverTime.getUTCDate() + daysUntilMonday,
  ));
  const successfulPayload = {
    serverTime: serverTime.toISOString(),
    current: {
      trackId: featuredTrack.id,
      name: featuredTrack.name,
      author: featuredTrack.author,
      lastModified: featuredTrack.lastModified,
      environment: { Summer: 1, Winter: 2, Desert: 3 }[featuredTrack.environment],
      thumbnailUrl:
        `/main/tracks/community/thumbnails/${featuredTrack.assetFile.replace(/\.track$/, ".png")}`,
      coverUrl: null,
      trackUrl: `/main/tracks/community/${featuredTrack.assetFile}`,
      endTime: endTime.toISOString(),
    },
  };

  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-weekly-outage-"),
  );
  const browser = await launchProfile(profileDirectory);
  t.after(async () => {
    await browser.close();
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWeeklyApiOutageProbe(successfulPayload),
  });
  await browser.client.call("Page.navigate", { url: browserUrl });
  await waitFor(
    browser.client,
    "window.__polytrackStartupReady === true",
    "PolyTrack startup",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.main-buttons-container:not(.hidden)')",
    "PolyTrack main menu",
  );
  await waitFor(
    browser.client,
    "window.__polytrackWeeklyTrackStatus === 'unavailable' && " +
      "document.querySelector('#polytrack-weekly-status')",
    "visible Track of the Week outage message",
  );
  assert.equal(
    await browser.client.evaluate("window.__polytrackWeeklyRequestCount"),
    1,
    "the weekly request should fail once without silently retrying",
  );
  assert.equal(
    await browser.client.evaluate(
      "document.querySelector('#polytrack-weekly-status')?.innerText.includes(" +
        "'Regular tracks are still available.')",
    ),
    true,
    "the outage notice should explain that regular tracks remain available",
  );

  const personalBestSnapshot = async () => JSON.parse(
    await browser.client.evaluate(`JSON.stringify(
      Object.keys(localStorage)
        .filter((key) =>
          /^polytrack_v5_(?:prod|dev|beta)_record\\d*_/.test(key))
        .sort()
        .map((key) => [key, localStorage.getItem(key)]))`),
  );
  const beforeBrowsing = await personalBestSnapshot();
  assert.deepEqual(beforeBrowsing, [], "the isolated test profile starts without personal bests");

  assert.equal(
    await clickVisibleButton(browser.client, "button", "Play"),
    true,
    "the main-menu Play control should remain usable during the outage",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-selection-ui:not(.hidden)')",
    "track picker during the outage",
  );

  assert.equal(
    await clickVisibleButton(
      browser.client,
      ".track-selection-ui .button.official",
      "Official tracks",
    ),
    true,
    "the Official tracks category should remain usable during the outage",
  );
  const selectTrack = async (name) => browser.client.evaluate(`(() => {
    const button = [...document.querySelectorAll(
      ".track-selection-ui .tracks-container.open .track > .button",
    )].find((item) =>
      item.querySelector(".track-title > p")?.textContent.trim() ===
        ${JSON.stringify(name)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(
    await selectTrack("Summer 1"),
    true,
    "an official track should still open during the outage",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-info-ui')?.innerText.includes('Summer 1') && " +
      "[...document.querySelectorAll('.track-info-ui button')].some((button) => " +
      "button.innerText.trim() === 'Play' && !button.disabled)",
    "official track details and Play control",
  );
  assert.equal(
    await clickVisibleButton(browser.client, ".track-info-ui button", "Back"),
    true,
    "the official track details should return to the picker",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-selection-ui:not(.hidden)')",
    "track picker after returning from an official track",
  );

  assert.equal(
    await clickVisibleButton(
      browser.client,
      ".track-selection-ui .button.community",
      "Community tracks",
    ),
    true,
    "the Community tracks category should remain usable during the outage",
  );
  assert.equal(
    await selectTrack("The Eldritch Estate"),
    true,
    "a community track should still open during the outage",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-info-ui')?.innerText.includes('The Eldritch Estate') && " +
      "[...document.querySelectorAll('.track-info-ui button')].some((button) => " +
      "button.innerText.trim() === 'Play' && !button.disabled)",
    "community track details and Play control",
  );

  assert.equal(
    await browser.client.evaluate(
      "document.querySelector('#polytrack-weekly-status button')?.innerText.trim()",
    ),
    "Retry",
    "the outage notice should provide a working Retry control",
  );
  assert.equal(
    await clickVisibleButton(
      browser.client,
      "#polytrack-weekly-status button",
      "Retry",
    ),
    true,
    "the Retry control should accept a click",
  );
  await waitFor(
    browser.client,
    "window.__polytrackWeeklyTrackStatus === 'available' && " +
      "!document.querySelector('#polytrack-weekly-status')",
    "weekly feature recovery after retry",
  );
  assert.equal(
    await browser.client.evaluate("window.__polytrackWeeklyRequestCount"),
    2,
    "retry should issue a new weekly request",
  );
  assert.deepEqual(
    await personalBestSnapshot(),
    beforeBrowsing,
    "browsing and retrying must not alter personal-best storage",
  );
});

test("a stalled Track of the Week response body times out and recovers on retry", {
  skip: !weeklyOutageEnabled,
  timeout: timeoutMs + 30_000,
}, async (t) => {
  const { communityTrackImports } = await import("../community-track-imports.js");
  const featuredTrack = communityTrackImports.find(
    ({ name }) => name === "The Eldritch Estate",
  );
  assert.ok(featuredTrack, "the community registry includes The Eldritch Estate");
  const serverTime = new Date();
  const daysUntilMonday = (8 - serverTime.getUTCDay()) % 7 || 7;
  const endTime = new Date(Date.UTC(
    serverTime.getUTCFullYear(),
    serverTime.getUTCMonth(),
    serverTime.getUTCDate() + daysUntilMonday,
  ));
  const successfulPayload = {
    serverTime: serverTime.toISOString(),
    current: {
      trackId: featuredTrack.id,
      name: featuredTrack.name,
      author: featuredTrack.author,
      lastModified: featuredTrack.lastModified,
      environment: { Summer: 1, Winter: 2, Desert: 3 }[featuredTrack.environment],
      thumbnailUrl:
        `/main/tracks/community/thumbnails/${featuredTrack.assetFile.replace(/\.track$/, ".png")}`,
      coverUrl: null,
      trackUrl: `/main/tracks/community/${featuredTrack.assetFile}`,
      endTime: endTime.toISOString(),
    },
  };

  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "polytrack-weekly-stall-"),
  );
  const browser = await launchProfile(profileDirectory);
  t.after(async () => {
    await browser.close();
    await rm(profileDirectory, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
  });

  await browser.client.call("Page.enable");
  await browser.client.call("Runtime.enable");
  await browser.client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createWeeklyApiBodyStallProbe(successfulPayload),
  });
  await browser.client.call("Page.navigate", { url: browserUrl });
  await waitFor(
    browser.client,
    "window.__polytrackStartupReady === true",
    "PolyTrack startup",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.main-buttons-container:not(.hidden)')",
    "PolyTrack main menu",
  );
  assert.equal(
    await browser.client.evaluate(
      "window.__polytrackWeeklyTrackStatus === 'loading' && " +
        "window.__polytrackWeeklyRequestCount === 1 && " +
        "window.__polytrackWeeklyHeadersReceived && " +
        "window.__polytrackWeeklyResponseStatus === 200 && " +
        "window.__polytrackWeeklyJsonCallCount === 1 && " +
        "!window.__polytrackWeeklyRequestAborted",
    ),
    true,
    "the successful response should remain pending while its JSON body is stalled",
  );

  assert.equal(
    await clickVisibleButton(browser.client, "button", "Play"),
    true,
    "the main-menu Play control should remain usable while the request is pending",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-selection-ui:not(.hidden)')",
    "track picker while the weekly request is pending",
  );
  const selectTrack = async (name) => browser.client.evaluate(`(() => {
    const button = [...document.querySelectorAll(
      ".track-selection-ui .tracks-container.open .track > .button",
    )].find((item) =>
      item.querySelector(".track-title > p")?.textContent.trim() ===
        ${JSON.stringify(name)});
    if (!button) return false;
    button.click();
    return true;
  })()`);

  assert.equal(
    await clickVisibleButton(
      browser.client,
      ".track-selection-ui .button.official",
      "Official tracks",
    ),
    true,
    "the Official tracks category should remain usable while the request is pending",
  );
  assert.equal(await selectTrack("Summer 1"), true, "an official track should open");
  await waitFor(
    browser.client,
    "document.querySelector('.track-info-ui')?.innerText.includes('Summer 1') && " +
      "[...document.querySelectorAll('.track-info-ui button')].some((button) => " +
      "button.innerText.trim() === 'Play' && !button.disabled)",
    "official track details and Play control while the request is pending",
  );
  assert.equal(
    await clickVisibleButton(browser.client, ".track-info-ui button", "Back"),
    true,
    "the official track details should return to the picker",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-selection-ui:not(.hidden)')",
    "track picker after returning from an official track",
  );

  assert.equal(
    await clickVisibleButton(
      browser.client,
      ".track-selection-ui .button.community",
      "Community tracks",
    ),
    true,
    "the Community tracks category should remain usable while the request is pending",
  );
  assert.equal(
    await selectTrack("The Eldritch Estate"),
    true,
    "a community track should open",
  );
  await waitFor(
    browser.client,
    "document.querySelector('.track-info-ui')?.innerText.includes('The Eldritch Estate') && " +
      "[...document.querySelectorAll('.track-info-ui button')].some((button) => " +
      "button.innerText.trim() === 'Play' && !button.disabled)",
    "community track details and Play control while the request is pending",
  );
  assert.equal(
    await browser.client.evaluate(
      "window.__polytrackWeeklyTrackStatus === 'loading' && " +
        "!window.__polytrackWeeklyRequestAborted",
    ),
    true,
    "official and community tracks should stay usable before the request timeout",
  );

  await waitFor(
    browser.client,
    "window.__polytrackWeeklyTrackStatus === 'unavailable' && " +
      "window.__polytrackWeeklyRequestAborted && " +
      "document.querySelector('#polytrack-weekly-status')",
    "weekly timeout error and recovery controls",
  );
  assert.equal(
    await browser.client.evaluate(
      "document.querySelector('#polytrack-weekly-status')?.innerText.includes(" +
        "'Track of the Week is unavailable. Regular tracks are still available.')",
    ),
    true,
    "the timeout should show the non-blocking unavailable message",
  );
  assert.equal(
    await browser.client.evaluate(
      "document.querySelector('#polytrack-weekly-status button')?.innerText.trim()",
    ),
    "Retry",
    "the timeout notice should provide a Retry control",
  );
  assert.equal(
    await clickVisibleButton(
      browser.client,
      "#polytrack-weekly-status button",
      "Retry",
    ),
    true,
    "the Retry control should accept a click after timeout",
  );
  await waitFor(
    browser.client,
    "window.__polytrackWeeklyTrackStatus === 'available' && " +
      `window.__polytrackCurrentWeeklyTrack?.id === ${JSON.stringify(featuredTrack.id)} && ` +
      "!document.querySelector('#polytrack-weekly-status')",
    "weekly feature recovery after retry",
  );
  assert.equal(
    await browser.client.evaluate("window.__polytrackWeeklyRequestCount"),
    2,
    "retry should issue a new weekly request",
  );
  assert.equal(
    await clickVisibleButton(browser.client, ".track-info-ui button", "Back"),
    true,
    "the community track details should return to the picker after retry",
  );
  await waitFor(
    browser.client,
    `(() => document.querySelector(
      ".track-selection-ui .tracks-container.open .track.track-of-the-week",
    )?.getAttribute("data-polytrack-weekly-track") ===
      ${JSON.stringify(featuredTrack.id)})()`,
    "the recovered weekly track card",
  );
});
