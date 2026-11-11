const { test } = require("node:test");
const assert = require("node:assert/strict");

const environment = {
  TURN_PROVIDER: "cloudflare",
  CLOUDFLARE_TURN_KEY_ID: "test-key-id",
  CLOUDFLARE_TURN_API_TOKEN: "test-only-api-token",
  TURN_CREDENTIAL_TTL_SECONDS: "600",
};
const iceServers = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  {
    urls: [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turns:turn.cloudflare.com:443?transport=tcp",
    ],
    username: "temporary-user",
    credential: "temporary-password",
  },
];

test("Cloudflare provider requests expiring credentials and preserves ICE output", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  let calls = 0;
  const result = await createConfiguredIceServers(environment, async (url, options) => {
    calls += 1;
    assert.equal(url, "https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id/credentials/generate-ice-servers");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-only-api-token");
    assert.deepEqual(JSON.parse(options.body), { ttl: 600 });
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ iceServers }) };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, iceServers);
  assert.ok(!JSON.stringify(result).includes(environment.CLOUDFLARE_TURN_API_TOKEN));
});

test("Cloudflare configuration and provider errors are explicit", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  const noNetwork = async () => assert.fail("Invalid configuration must not make a network request");
  await assert.rejects(
    createConfiguredIceServers({ TURN_PROVIDER: "cloudflare" }, noNetwork),
    /must be configured together/,
  );
  await assert.rejects(
    createConfiguredIceServers({ ...environment, CLOUDFLARE_TURN_KEY_ID: "../bad-key" }, noNetwork),
    /KEY_ID is invalid/,
  );
  await assert.rejects(
    createConfiguredIceServers({ ...environment, TURN_CREDENTIAL_TTL_SECONDS: "1e3" }, noNetwork),
    /whole number/,
  );
  await assert.rejects(
    createConfiguredIceServers({ TURN_PROVIDER: "unknown" }, noNetwork),
    /TURN_PROVIDER must be/,
  );
});

test("Cloudflare failures do not leak credentials or silently fall back to STUN", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  await assert.rejects(
    createConfiguredIceServers(environment, async () => {
      throw new Error(environment.CLOUDFLARE_TURN_API_TOKEN);
    }),
    (error) => error.message === "Could not contact Cloudflare TURN credential service",
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({ ok: false, status: 403 })),
    /returned HTTP 403/,
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }),
    })),
    /invalid ICE servers/,
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"] }] }),
    })),
    /invalid ICE servers/,
  );
});

test("Unconfigured provider retains the STUN-only default without contacting Cloudflare", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  const result = await createConfiguredIceServers({}, async () => assert.fail("Unexpected network request"));
  assert.equal(result.length, 1);
  assert.ok(result[0].urls.includes("stun:stun.l.google.com:19302"));
});