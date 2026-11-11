const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, createHmac } = require("node:crypto");
const WebSocket = require("ws");

const apiBase = new URL(
  process.env.TEST_API_BASE_URL || "http://localhost:80/api",
);
const apiPrefix = apiBase.pathname.replace(/\/+$/, "");
const gameVersion = "0.6.0-beta2";

function endpoint(path) {
  return new URL(`${apiPrefix}${path}`, apiBase.origin);
}

function webSocketUrl(role) {
  const url = endpoint(`/v6/multiplayer/${role}`);
  url.protocol = apiBase.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function makeClient(role) {
  const socket = new WebSocket(webSocketUrl(role));
  const queuedMessages = [];
  const waiters = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) =>
      waiter.predicate(message),
    );
    if (waiterIndex === -1) {
      queuedMessages.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  socket.on("error", () => {});

  return {
    socket,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    waitFor(predicate, timeoutMs = 8000) {
      const queuedIndex = queuedMessages.findIndex(predicate);
      if (queuedIndex !== -1) {
        return Promise.resolve(queuedMessages.splice(queuedIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for ${role} WebSocket message`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function closeClients(clients) {
  await Promise.all(
    clients.map(
      (socket) =>
        new Promise((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            socket.terminate();
            resolve();
          }, 1000);
          timer.unref();
          socket.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.close();
        }),
    ),
  );
}

test("ICE endpoint preserves its STUN response and supported-version contract", async () => {
  const validUrl = endpoint(`/v6/iceServers?version=${gameVersion}`);
  const validResponse = await fetch(validUrl);
  assert.equal(validResponse.status, 200);
  assert.match(validResponse.headers.get("cache-control") || "", /no-store/);
  const servers = await validResponse.json();
  assert.ok(Array.isArray(servers));
  assert.ok(
    servers.some((server) =>
      server.urls.includes("stun:stun.l.google.com:19302"),
    ),
  );

  const invalidResponse = await fetch(
    endpoint("/v6/iceServers?version=unsupported"),
  );
  assert.equal(invalidResponse.status, 400);
});

test("TURN configuration issues short-lived coturn credentials alongside STUN", async () => {
  const { createIceServers } = await import("../src/lib/ice-servers.js");
  const now = 1_700_000_000_000;
  const sharedSecret = " test-only-turn-shared-secret ";
  const servers = createIceServers(
    {
      TURN_URLS: "turn:relay.example.test:3478?transport=udp, turns:relay.example.test:5349",
      TURN_SHARED_SECRET: sharedSecret,
      TURN_CREDENTIAL_TTL_SECONDS: "600",
    },
    now,
  );

  assert.equal(servers.length, 2);
  assert.ok(
    servers[0].urls.includes("stun:stun.l.google.com:19302"),
    "STUN remains available when TURN is configured",
  );

  const turnServer = servers[1];
  assert.deepEqual(turnServer.urls, [
    "turn:relay.example.test:3478?transport=udp",
    "turns:relay.example.test:5349",
  ]);
  assert.equal(turnServer.credentialType, "password");
  assert.match(turnServer.username, /^1700000600:[0-9a-f-]{36}$/);
  assert.equal(
    turnServer.credential,
    createHmac("sha1", sharedSecret)
      .update(turnServer.username)
      .digest("base64"),
  );
});

test("Open Relay configuration includes credentialed TCP and TLS routes", async () => {
  const { createMeteredOpenRelayIceServers } = await import(
    "../src/lib/ice-servers.js"
  );
  const servers = createMeteredOpenRelayIceServers({}, 1_700_000_000_000);
  const turnServer = servers.find((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url));
  });
  assert.ok(turnServer, "Open Relay TURN server is missing");
  const urls = Array.isArray(turnServer.urls) ? turnServer.urls : [turnServer.urls];
  assert.ok(
    urls.some((url) => /^turn:/i.test(url) && /[?&]transport=tcp(?:&|$)/i.test(url)),
    "Open Relay TURN/TCP route is missing",
  );
  assert.ok(
    urls.some((url) => /^turns:/i.test(url) && /[?&]transport=tcp(?:&|$)/i.test(url)),
    "Open Relay TURN/TLS route is missing",
  );
  assert.equal(turnServer.credentialType, "password");
  assert.ok(
    typeof turnServer.username === "string" && turnServer.username.length > 0,
    "Open Relay TURN username is missing",
  );
  assert.ok(
    typeof turnServer.credential === "string" && turnServer.credential.length > 0,
    "Open Relay TURN credential is missing",
  );
});

test("separate ICE credential limiters share one client's request allowance", async () => {
  const {
    createIceCredentialRateLimiter,
    createPostgresIceCredentialRateLimitStore,
  } = await import("../src/lib/ice-servers.js");
  let now = 1_700_000_000_000;
  const entries = new Map();
  const queries = [];
  const query = async (statement, parameters) => {
    queries.push({ statement, parameters });
    if (statement.includes("DELETE FROM ice_credential_rate_limits")) {
      return { rows: [] };
    }

    assert.match(statement, /ON CONFLICT \(client_key\) DO UPDATE/);
    const [clientKey, windowMs, maximumStoredCount] = parameters;
    let entry = entries.get(clientKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + Number(windowMs) };
      entries.set(clientKey, entry);
    }
    entry.count = Math.min(entry.count + 1, Number(maximumStoredCount));
    return {
      rows: [
        {
          request_count: entry.count,
          retry_after_seconds: Math.max(
            1,
            Math.ceil((entry.resetAt - now) / 1000),
          ),
        },
      ],
    };
  };
  const createServerLimiter = () =>
    createIceCredentialRateLimiter({
      store: createPostgresIceCredentialRateLimitStore({
        query,
        onCleanupError: () => {},
        now: () => now,
      }),
      maxRequests: 3,
      windowMs: 60_000,
    });
  const checkRequestOnServerOne = createServerLimiter();
  const checkRequestOnServerTwo = createServerLimiter();

  assert.equal(await checkRequestOnServerOne("192.0.2.1"), 0);
  assert.equal(await checkRequestOnServerTwo("192.0.2.1"), 0);
  assert.equal(await checkRequestOnServerOne("192.0.2.1"), 0);
  assert.equal(await checkRequestOnServerTwo("192.0.2.1"), 60);
  assert.equal(
    await checkRequestOnServerTwo("192.0.2.2"),
    0,
    "one client's request limit does not block other clients",
  );

  const firstClientKey = createHash("sha256")
    .update("192.0.2.1")
    .digest("hex");
  const reserveQueries = queries.filter(({ statement }) =>
    statement.includes("INSERT INTO ice_credential_rate_limits"),
  );
  assert.ok(reserveQueries.length >= 4);
  assert.ok(
    reserveQueries.every(
      ({ parameters }) =>
        parameters[0] === firstClientKey ||
        parameters[0] === createHash("sha256")
          .update("192.0.2.2")
          .digest("hex"),
    ),
    "the shared counter receives hashed client identifiers",
  );
  assert.deepEqual(
    Object.keys(entries.get(firstClientKey)).sort(),
    ["count", "resetAt"],
    "shared counter state contains only the request count and reset window",
  );

  now += 60_000;
  assert.equal(await checkRequestOnServerTwo("192.0.2.1"), 0);
});

test("TURN configuration errors are explicit and STUN-only remains the default", async () => {
  const { createIceServers } = await import("../src/lib/ice-servers.js");
  const stunOnlyServers = createIceServers({});
  assert.equal(stunOnlyServers.length, 1);
  assert.ok(stunOnlyServers[0].urls.includes("stun:stun.l.google.com:19302"));

  assert.throws(
    () => createIceServers({ TURN_URLS: "turn:relay.example.test:3478" }),
    /TURN_URLS and TURN_SHARED_SECRET must be configured together/,
  );
  assert.throws(
    () =>
      createIceServers({
        TURN_URLS: "stun:stun.example.test:3478",
        TURN_SHARED_SECRET: "test-only-turn-shared-secret",
      }),
    /TURN_URLS must contain unique comma-separated TURN or TURNS URLs/,
  );
  assert.throws(
    () =>
      createIceServers({
        TURN_URLS: "turn:relay.example.test:3478",
        TURN_SHARED_SECRET: "test-only-turn-shared-secret",
        TURN_CREDENTIAL_TTL_SECONDS: "30",
      }),
    /TURN_CREDENTIAL_TTL_SECONDS must be a whole number from 60 to 86400/,
  );
  assert.throws(
    () =>
      createIceServers({
        TURN_URLS: "turn:relay.example.test:3478",
        TURN_SHARED_SECRET: "test-only-turn-shared-secret",
        TURN_CREDENTIAL_TTL_SECONDS: "1e3",
      }),
    /TURN_CREDENTIAL_TTL_SECONDS must be a whole number from 60 to 86400/,
  );
});

test("host and seven joiners exchange offers, answers, and ICE candidates", async (t) => {
  const host = makeClient("host");
  const joiners = Array.from({ length: 7 }, (_, index) => ({
    nickname: `Racer ${index + 1}`,
    client: makeClient("join"),
  }));
  const clients = [host.socket, ...joiners.map(({ client }) => client.socket)];
  t.after(() => closeClients(clients));

  await Promise.all(clients.map(waitForOpen));
  host.send({
    version: gameVersion,
    type: "createInvite",
    nickname: "Host Driver",
  });
  const invite = await host.waitFor((message) => message.type === "createInvite");
  assert.match(invite.inviteCode, /^\d{4}$/);
  assert.ok(invite.timeoutMilliseconds > 0);
  assert.equal(
    invite.censoredNickname,
    "Host Driver",
    "the host's nickname is initialized before joiners connect",
  );

  for (const { nickname, client } of joiners) {
    client.send({
      version: gameVersion,
      inviteCode: invite.inviteCode,
      offer: `offer-${nickname}`,
      mods: [],
      isModsVanillaCompatible: true,
      nickname,
      countryCode: null,
      carStyle: "{}",
    });
    // ICE trickling can send candidates immediately after the initial offer.
    // The server must process them after that offer reserves the join session.
    client.send({
      version: gameVersion,
      candidate: { candidate: `joiner-candidate-${nickname}` },
    });
  }

  const hostInvites = await Promise.all(
    joiners.map(() => host.waitFor((message) => message.type === "joinInvite")),
  );
  assert.equal(new Set(hostInvites.map((message) => message.session)).size, 7);
  const earlyCandidates = await Promise.all(
    joiners.map(({ nickname }) =>
      host.waitFor(
        (message) =>
          message.type === "iceCandidate" &&
          message.candidate?.candidate === `joiner-candidate-${nickname}`,
      ),
    ),
  );
  assert.equal(
    new Set(earlyCandidates.map((message) => message.session)).size,
    7,
    "ICE candidates sent immediately after an offer are associated with its session",
  );

  for (const request of hostInvites) {
    host.send({
      version: gameVersion,
      type: "acceptJoin",
      session: request.session,
      answer: `answer-${request.nickname}`,
      mods: [],
      isModsVanillaCompatible: true,
      clientId: joiners.findIndex(
        ({ nickname }) => nickname === request.nickname,
      ) + 1,
    });
  }

  for (const { nickname, client } of joiners) {
    const accepted = await client.waitFor(
      (message) => message.type === "acceptJoin",
    );
    assert.equal(accepted.answer, `answer-${nickname}`);
  }

  const joinerByName = new Map(
    joiners.map(({ nickname, client }) => [nickname, client]),
  );
  for (const [index, request] of hostInvites.entries()) {
    host.send({
      version: gameVersion,
      type: "iceCandidate",
      session: request.session,
      candidate: { candidate: `host-candidate-${index}` },
    });
  }
  for (const request of hostInvites) {
    const joiner = joinerByName.get(request.nickname);
    assert.ok(joiner);
    const candidate = await joiner.waitFor(
      (message) => message.type === "iceCandidate",
    );
    assert.equal(typeof candidate.candidate.candidate, "string");
  }

  for (const { client } of joiners) {
    client.send({ version: gameVersion, candidate: null });
  }
  const joinerCandidates = await Promise.all(
    joiners.map(() =>
      host.waitFor(
        (message) =>
          message.type === "iceCandidate" && message.candidate === null,
      ),
    ),
  );
  assert.equal(new Set(joinerCandidates.map((message) => message.session)).size, 7);
});