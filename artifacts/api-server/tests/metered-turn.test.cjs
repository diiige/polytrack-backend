const { test } = require("node:test");
const assert = require("node:assert/strict");

const environment = {
  TURN_PROVIDER: "metered",
  METERED_TURN_APP_NAME: "polytrack-test",
  METERED_TURN_API_KEY: "test-only-metered-api-key",
};
const iceServers = [
  { urls: ["stun:stun.relay.metered.ca:80"] },
  {
    urls: [
      "turn:standard.relay.metered.ca:80?transport=udp",
      "turns:standard.relay.metered.ca:443?transport=tcp",
    ],
    username: "temporary-user",
    credential: "temporary-password",
  },
];

test("Metered provider fetches ICE servers server-side and preserves the response", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  let calls = 0;
  const result = await createConfiguredIceServers(environment, async (url, options) => {
    calls += 1;
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, "https://polytrack-test.metered.live");
    assert.equal(requestUrl.pathname, "/api/v1/turn/credentials");
    assert.equal(requestUrl.searchParams.get("apiKey"), environment.METERED_TURN_API_KEY);
    assert.equal(options.method, "GET");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => iceServers };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, iceServers);
  assert.ok(!JSON.stringify(result).includes(environment.METERED_TURN_API_KEY));
});

test("Metered provider validates configuration before contacting the service", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  const noNetwork = async () => assert.fail("Invalid configuration must not make a network request");
  await assert.rejects(
    createConfiguredIceServers({ TURN_PROVIDER: "metered" }, noNetwork),
    /must be configured together/,
  );
  await assert.rejects(
    createConfiguredIceServers(
      { ...environment, METERED_TURN_APP_NAME: "https://attacker.example" },
      noNetwork,
    ),
    /APP_NAME is invalid/,
  );
});

test("Metered failures are sanitized and never silently fall back to STUN", async () => {
  const { createConfiguredIceServers } = await import("../src/lib/ice-servers.js");
  await assert.rejects(
    createConfiguredIceServers(environment, async () => {
      throw new Error(environment.METERED_TURN_API_KEY);
    }),
    (error) => error.message === "Could not contact Metered Open Relay credential service",
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({ ok: false, status: 403 })),
    /returned HTTP 403/,
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({
      ok: true,
      json: async () => [{ urls: ["stun:stun.relay.metered.ca:80"] }],
    })),
    /invalid ICE servers/,
  );
  await assert.rejects(
    createConfiguredIceServers(environment, async () => ({
      ok: true,
      json: async () => [{
        urls: ["turn:standard.relay.metered.ca:80"],
      }],
    })),
    /invalid ICE servers/,
  );
});